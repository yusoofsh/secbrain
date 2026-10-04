import { z } from "zod";
import type { Env } from "../env";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const settingsReadName = "plugin_settings_read";
export const settingsUpdateName = "plugin_settings_update";
export const defaults = { recentLimit: 10, recallLimit: 5, defaultLayer: "all" as "all" | "personal" | "company", defaultProject: "" };
const fields = z.object({
  recentLimit: z.number().int().min(1).max(25),
  recallLimit: z.number().int().min(1).max(10),
  defaultLayer: z.enum(["all", "personal", "company"]),
  defaultProject: z.string().max(64).refine(value => value === "" || /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)),
}).strict();
const update = z.object({ set: fields.partial().refine(value => Object.keys(value).length > 0) }).strict();
export type Preferences = z.infer<typeof fields>;
export type PreferenceStore = ReturnType<typeof createPreferenceStore>;
const table = `CREATE TABLE IF NOT EXISTS mcp_plugin_preferences (
  user_id TEXT PRIMARY KEY,
  values_json TEXT NOT NULL DEFAULT '{}',
  saved_at INTEGER NOT NULL
)`;

function effective(raw: string | undefined): Preferences {
  if (raw === undefined) return { ...defaults };
  const stored = fields.partial().parse(JSON.parse(raw));
  return fields.parse({ ...defaults, ...stored });
}
/** The caller supplies an identity resolved by the existing auth boundary, never a tool argument. */
export function createPreferenceStore(db: Env["DB"], userId: string) {
  if (!userId.trim() || userId.length > 200) throw new Error("Authenticated identity is required");
  return {
    async read(): Promise<Preferences> {
      try {
        const row = await db.prepare("SELECT values_json FROM mcp_plugin_preferences WHERE user_id = ?").bind(userId).first<{ values_json: string }>();
        return effective(row?.values_json);
      } catch (error) {
        // A fresh or rolled-back install has no preferences until its first explicit write.
        if (error instanceof Error && /no such table: (?:main\.)?mcp_plugin_preferences\b/.test(error.message)) return { ...defaults };
        throw new Error("Preferences could not be read. Try the read again.");
      }
    },
    async update(raw: unknown): Promise<Preferences> {
      const patch = update.parse(raw).set;
      try {
        // One D1 transaction creates storage and merges only the supplied fields.
        // The SELECT remains inside the same atomic batch, not a later racing read.
        const results = await db.batch([
          db.prepare(table),
          db.prepare(`INSERT INTO mcp_plugin_preferences (user_id, values_json, saved_at) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET values_json = json_patch(mcp_plugin_preferences.values_json, excluded.values_json), saved_at = excluded.saved_at
            `).bind(userId, JSON.stringify(patch), Date.now()),
          db.prepare("SELECT values_json FROM mcp_plugin_preferences WHERE user_id = ?").bind(userId),
        ]);
        const row = results[2]?.results?.[0] as { values_json?: unknown } | undefined;
        if (!results.every(result => result.success) || typeof row?.values_json !== "string") throw new Error("Persistence failed");
        return effective(row.values_json);
      } catch { throw new Error("Preferences could not be saved. Read the current values before retrying."); }
    },
  };
}
export const settingsSchema = {
  type: "object", additionalProperties: false,
  properties: {
    recentLimit: { type: "integer", title: "Recent memories per read", minimum: 1, maximum: 25 },
    recallLimit: { type: "integer", title: "Recall matches per read", minimum: 1, maximum: 10 },
    defaultLayer: { type: "string", title: "Default memory layer", enum: ["all", "personal", "company"], description: "A read filter only. It does not change membership or grant access." },
    defaultProject: { type: "string", title: "Default project slug", maxLength: 64, pattern: "^$|^[a-z0-9][a-z0-9_-]{0,63}$", description: "Leave empty for no default project. The existing read checks project access." },
  },
  required: ["recentLimit", "recallLimit", "defaultLayer", "defaultProject"],
};
export const settingsTools: Tool[] = [
  { name: settingsReadName, title: "Plugin preferences", description: "Read your effective non-secret plugin preferences without changing stored data.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: { ui: { visibility: ["app"] } } },
  { name: settingsUpdateName, title: "Save plugin preferences", description: "Save the supplied non-secret preferences for the authenticated user. Omitted fields stay unchanged. This changes preferences only, never memories, project membership or sharing permissions.",
    inputSchema: { type: "object", properties: { set: { type: "object", properties: settingsSchema.properties, additionalProperties: false, minProperties: 1 } }, required: ["set"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: { ui: { visibility: ["app"] } } },
];
export async function settingsCall(name: string, args: unknown, store: PreferenceStore) {
  try {
    let data: Record<string, unknown>;
    if (name === settingsReadName) {
      z.object({}).strict().parse(args ?? {});
      data = { schema: settingsSchema, layout: [{ kind: "group", title: "Default memory reads", items: Object.keys(defaults).map(property => ({ kind: "property", property })) }], values: await store.read() };
    } else data = { values: await store.update(args) };
    return { resultType: "complete" as const, content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) {
    const text = error instanceof z.ZodError ? "Preferences were invalid. Use the declared keys and value bounds." : "Preferences are unavailable. Read the current values before retrying.";
    return { resultType: "complete" as const, isError: true, content: [{ type: "text" as const, text }] };
  }
}
/** This only fills omitted inputs. Original tools still enforce every data-access rule. */
export function mergeDefaults(name: string, args: Record<string, unknown> | undefined, preferences: Preferences) {
  const result = { ...args };
  if (name !== "list_recent" && name !== "recall") return result;
  const limitKey = name === "list_recent" ? "n" : "topK";
  if (!Object.hasOwn(result, limitKey)) result[limitKey] = name === "list_recent" ? preferences.recentLimit : preferences.recallLimit;
  if (!Object.hasOwn(result, "workspace") && preferences.defaultLayer !== "all") result.workspace = preferences.defaultLayer;
  if (!Object.hasOwn(result, "project") && preferences.defaultProject) result.project = preferences.defaultProject;
  return result;
}
