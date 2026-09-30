import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { Buffer } from "node:buffer";
import type { Env } from "../env";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { relayPost } from "./relay";
import {
  resolveIdentityFromToken,
  resolveIdentityByUserId,
} from "../lib/identity";
import { initializeDatabase } from "../db/init";
import {
  EventHub,
  type EventDefinition,
  type EventStore,
  type Subscription,
  type Delivery,
} from "./core";

export const secbrainEvents: EventDefinition[] = [
  "memory.created",
  "memory.updated",
].map((name) => ({
  name,
  description:
    name === "memory.created"
      ? "A memory was created in an authorized workspace. Reference-only updates checked every minute."
      : "A memory was edited, appended, or had its status changed in an authorized workspace. Reference-only updates checked every minute.",
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: { workspace_id: { type: "string" } },
    required: ["workspace_id"],
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: {
      workspace_id: { type: "string" },
      entry_id: { type: "string" },
    },
    required: ["workspace_id", "entry_id"],
    additionalProperties: false,
  },
}));
const ready = new WeakSet<object>();
async function storage(env: Env) {
  await initializeDatabase(env);
  if (!ready.has(env.DB)) {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS mcp_event_state (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL)",
    ).run();
    await env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS mcp_event_state_kind ON mcp_event_state(kind)",
    ).run();
    ready.add(env.DB);
  }
  const key = createHash("sha256")
    .update("mcp-events:" + env.AUTH_TOKEN)
    .digest();
  function seal(id: string, data: unknown) {
    const iv = Buffer.from(randomBytes(12)),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(data)),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    );
  }
  function open(id: string, payload: string) {
    const bytes = Buffer.from(payload, "base64"),
      cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(id));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        cipher.update(bytes.subarray(28)),
        cipher.final(),
      ]).toString(),
    );
  }
  const put = async (kind: string, id: string, payload: unknown) => {
    await env.DB.prepare(
      "INSERT INTO mcp_event_state(id,kind,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,payload=excluded.payload",
    )
      .bind(id, kind, seal(id, payload))
      .run();
  };
  const list = async <T>(kind: string): Promise<T[]> => {
    const rows = await env.DB.prepare(
      "SELECT id,payload FROM mcp_event_state WHERE kind=? LIMIT 1001",
    )
      .bind(kind)
      .all<{ id: string; payload: string }>();
    if ((rows.results?.length ?? 0) > 1000)
      throw new Error("MCP event state limit reached");
    return (rows.results ?? []).map((row) => open(row.id, row.payload) as T);
  };
  const remove = async (id: string) => {
    await env.DB.prepare("DELETE FROM mcp_event_state WHERE id=?")
      .bind(id)
      .run();
  };
  const persistence: EventStore = {
    subscriptions: () => list<Subscription>("subscription"),
    putSubscription: (s) => put("subscription", s.id, s),
    deleteSubscription: remove,
    deliveries: () => list<Delivery>("delivery"),
    putDelivery: (d) => put("delivery", d.id, d),
    deleteDelivery: remove,
  };
  return { persistence, put, list };
}
export async function secbrainEventHub(env: Env) {
  const state = await storage(env);
  const hub = new EventHub(
    secbrainEvents,
    state.persistence,
    relayPost(env.MCP_EVENTS_RELAY_URL!, env.MCP_EVENTS_RELAY_TOKEN!),
    async (s) => {
      const credential = (
        await state.list<{
          owner: string;
          token: string;
          userId: string;
          oauth: boolean;
        }>("authorization")
      ).find((a) => a.owner === s.owner);
      if (!credential) return false;
      let identity;
      if (credential.oauth) {
        const token = await getOAuthApi(
          {
            apiRoute: "/mcp",
            apiHandler: {} as never,
            defaultHandler: {} as never,
            authorizeEndpoint: "/oauth/authorize",
            tokenEndpoint: "/oauth/token",
            clientRegistrationEndpoint: "/oauth/register",
          },
          env,
        ).unwrapToken(credential.token);
        if (!token || token.expiresAt * 1000 <= Date.now()) return false;
        identity = await resolveIdentityByUserId(env, credential.userId);
      } else
        identity =
          credential.token === env.AUTH_TOKEN
            ? await resolveIdentityByUserId(env, "owner")
            : await resolveIdentityFromToken(credential.token, env);
      return Boolean(
        identity &&
        [
          identity.personalWorkspaceId,
          ...identity.companyWorkspaceIds,
        ].includes(s.arguments.workspace_id),
      );
    },
  );
  return {
    hub,
    state,
    async prepare(workspace: string) {
      const sources = await state.list<{ workspace: string; after: number }>(
        "source",
      );
      if (sources.some((s) => s.workspace === workspace)) return;
      const row = await env.DB.prepare(
        "SELECT COALESCE(MAX(a.rowid),0) AS n FROM entry_events a JOIN entries e ON e.id=a.entry_id WHERE e.workspace_id=?",
      )
        .bind(workspace)
        .first<{ n: number }>();
      await state.put("source", "source:" + workspace, {
        workspace,
        after: row?.n ?? 0,
      });
    },
  };
}
/** Audit rows are the durable source. Content is retrieved through existing scoped read tools. */
export async function tickSecbrainEvents(env: Env) {
  if (!env.MCP_EVENTS_RELAY_URL || !env.MCP_EVENTS_RELAY_TOKEN) return;
  const { hub, state } = await secbrainEventHub(env);
  const subscriptions = (await state.persistence.subscriptions()).filter(
    (s) => s.expires > Date.now(),
  );
  for (const workspace of new Set(
    subscriptions.map((s) => s.arguments.workspace_id),
  )) {
    const cursor = (
      await state.list<{ workspace: string; after: number }>("source")
    ).find((s) => s.workspace === workspace)?.after;
    // The first observation establishes a baseline rather than sending historical memories.
    const newest = await env.DB.prepare(
      "SELECT COALESCE(MAX(a.rowid),0) AS n FROM entry_events a JOIN entries e ON e.id=a.entry_id WHERE e.workspace_id=?",
    )
      .bind(workspace)
      .first<{ n: number }>();
    if (cursor === undefined) {
      await state.put("source", "source:" + workspace, {
        workspace,
        after: newest?.n ?? 0,
      });
      continue;
    }
    const rows = await env.DB.prepare(
      "SELECT a.rowid AS sequence,a.id,a.entry_id,a.event,a.created_at FROM entry_events a JOIN entries e ON e.id=a.entry_id WHERE e.workspace_id=? AND a.rowid>? ORDER BY a.rowid LIMIT 20",
    )
      .bind(workspace, cursor)
      .all<{
        sequence: number;
        id: string;
        entry_id: string;
        event: string;
        created_at: number;
      }>();
    let after = cursor;
    for (const row of rows.results ?? []) {
      const name =
        row.event === "created"
          ? "memory.created"
          : ["updated", "appended", "status_changed"].includes(row.event)
            ? "memory.updated"
            : undefined;
      if (name)
        await hub.emit(
          name,
          { workspace_id: workspace, entry_id: row.entry_id },
          "evt_" + row.id,
          new Date(row.created_at).toISOString(),
        );
      after = row.sequence;
    }
    await state.put("source", "source:" + workspace, { workspace, after });
  }
  await hub.flush();
}
