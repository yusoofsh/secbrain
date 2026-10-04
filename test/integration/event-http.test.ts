import { afterAll, expect, test } from "vitest";
import { createApiHandler } from "../../src/mcp/handler";
import { makeTestEnv } from "../helpers/make-env";
import { createHash } from "node:crypto";

const env = makeTestEnv({ MCP_EVENTS_RELAY_URL: "https://relay.example/deliver", MCP_EVENTS_RELAY_TOKEN: "relay-token" });
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => { if (String(input).startsWith("https://relay.example")) { const outer = JSON.parse(String(init?.body)), body = JSON.parse(outer.body); return Response.json({ status: 200, body: body.challenge ? { challenge: body.challenge } : {} }); } return original(input, init); };
afterAll(() => { globalThis.fetch = original; });
const ctx = { waitUntil(p: Promise<unknown>) { p.catch(() => {}); } } as ExecutionContext;
const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
const rpc = (method: string, params = {}, token = "Bearer test-token-123") => new Request("https://test.secbrain.local/api", { method: "POST", headers: { Authorization: token, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }) });
test("authenticates discovery/subscriptions on the real modern MCP route and persists restart state", async () => {
  env.MOCK.connectors.DB.database.prepare("INSERT INTO workspaces (id, slug, name, type, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("ws-owner", "owner", "Owner", "personal", "u_personal", Date.now());
  const userId = "u_" + createHash("sha256").update(env.MCP_USER_ID).digest("hex").slice(0, 16);
  env.MOCK.connectors.DB.database.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run("ws-owner", userId, "owner", Date.now());
  let handler = createApiHandler(); expect((await handler.fetch(rpc("events/list", {}, ""), env, ctx)).status).toBe(401);
  const caps = await (await handler.fetch(rpc("server/discover"), env, ctx)).json() as any; expect(caps.result.capabilities.events).toEqual({});
  const created = await (await handler.fetch(rpc("events/subscribe", { name: "memory.created", transport: "webhook", webhookUrl: "https://receiver.example/events", arguments: { workspace_id: "ws-owner" }, ttlMs: 10000 }), env, ctx)).json() as any;
  expect(created.result.resultType).toBe("complete"); expect(created.result.secret).toMatch(/^whsec_/);
  const denied = await (await handler.fetch(rpc("events/subscribe", { name: "memory.updated", transport: "webhook", webhookUrl: "https://receiver.example/events", arguments: { workspace_id: "not-a-member" } }), env, ctx)).json() as any; expect(denied.error.code).toBe(-32001);
  handler = createApiHandler(); const refreshed = await (await handler.fetch(rpc("events/subscribe", { subscriptionId: created.result.subscriptionId, name: "memory.created", transport: "webhook", webhookUrl: "https://receiver.example/events", arguments: { workspace_id: "ws-owner" } }), env, ctx)).json() as any; expect(refreshed.result.secret).toBe(created.result.secret);
  const removed = await (await handler.fetch(rpc("events/unsubscribe", { subscriptionId: created.result.subscriptionId }), env, ctx)).json() as any; expect(removed.result).toMatchObject({ resultType: "complete" });
});
