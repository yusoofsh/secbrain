import { describe, it, expect, vi } from "vitest";
import type { Env } from "../../src/env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { createPreferenceStore, defaults, mergeDefaults, settingsReadName, settingsUpdateName } from "../../src/workflows/settings";
import { modernHandler } from "../../src/mcp/modern";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function rpc(method: string, args: Record<string, unknown> = {}) {
  const name = args.name;
  return new Request("https://fixture.invalid/mcp", { method: "POST", headers: {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    "Mcp-Method": method, "MCP-Protocol-Version": "2026-07-28", ...(typeof name === "string" ? { "Mcp-Name": name } : {}),
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }) });
}
describe("persistent plugin settings", () => {
  it("returns defaults without writing, keeps users separate and persists across instances", async () => {
    const db = makeSqliteD1();
    try {
      const database = db.db as unknown as Env["DB"];
      const alice = createPreferenceStore(database, "alice");
      expect(await alice.read()).toEqual(defaults);
      expect(await alice.update({ set: { recentLimit: 7, defaultLayer: "personal" } })).toEqual({ ...defaults, recentLimit: 7, defaultLayer: "personal" });
      expect(await createPreferenceStore(database, "bob").read()).toEqual(defaults);
      expect(await createPreferenceStore(database, "alice").read()).toEqual({ ...defaults, recentLimit: 7, defaultLayer: "personal" });
      await alice.update({ set: { recallLimit: 3 } });
      expect(await alice.read()).toEqual({ ...defaults, recentLimit: 7, recallLimit: 3, defaultLayer: "personal" });
    } finally { db.close(); }
  });
  it("rejects invalid, empty and caller-scoped updates before database access", async () => {
    const prepare = vi.fn(); const batch = vi.fn();
    const store = createPreferenceStore({ prepare, batch } as unknown as Env["DB"], "alice");
    for (const input of [{}, { set: {} }, { set: { recentLimit: 0 } }, { set: { defaultLayer: "admin" } }, { set: { defaultProject: "../other" } }, { set: { secret: "x" } }, { set: { recallLimit: 2 }, userId: "bob" }]) {
      await expect(store.update(input)).rejects.toThrow();
    }
    expect(prepare).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled();
    expect(() => createPreferenceStore({} as Env["DB"], "")).toThrow();
  });
  it("preserves omitted fields across concurrent partial updates", async () => {
    const db = makeSqliteD1();
    try {
      const store = createPreferenceStore(db.db as unknown as Env["DB"], "alice");
      await store.update({ set: { recentLimit: 8 } });
      await Promise.all([store.update({ set: { recentLimit: 4 } }), store.update({ set: { recallLimit: 2 } })]);
      expect(await store.read()).toEqual({ ...defaults, recentLimit: 4, recallLimit: 2 });
    } finally { db.close(); }
  });
  it("only fills omitted read arguments and never adds an identity or expands explicit scope", () => {
    const preferences = { ...defaults, recentLimit: 6, recallLimit: 2, defaultLayer: "company" as const, defaultProject: "example" };
    expect(mergeDefaults("list_recent", {}, preferences)).toEqual({ n: 6, workspace: "company", project: "example" });
    expect(mergeDefaults("recall", { query: "q", topK: 1, workspace: "personal", project: "chosen" }, preferences)).toEqual({ query: "q", topK: 1, workspace: "personal", project: "chosen" });
    expect(mergeDefaults("get", { id: "x" }, preferences)).toEqual({ id: "x" });
  });
  it("advertises exact native settings metadata and applies defaults only to read tools", async () => {
    const db = makeSqliteD1(); const seen: unknown[] = [];
    const store = createPreferenceStore(db.db as unknown as Env["DB"], "alice");
    const handler = modernHandler(() => {
      const source = new McpServer({ name: "fixture", version: "1" });
      source.registerTool("list_recent", { inputSchema: {} }, (args) => { seen.push(args); return { content: [{ type: "text", text: "fixture" }] }; });
      return source;
    }, undefined, store);
    try {
      const discovery = await (await handler.fetch(rpc("server/discover"))).json() as any;
      expect(discovery.result.capabilities.extensions["openai/settings"]).toEqual({ readTool: settingsReadName, updateTool: settingsUpdateName });
      const read = await (await handler.fetch(rpc("tools/call", { name: settingsReadName, arguments: {} }))).json() as any;
      expect(read.result.structuredContent.values).toEqual(defaults);
      expect(read.result.structuredContent.schema.properties.recentLimit.default).toBeUndefined();
      const written = await (await handler.fetch(rpc("tools/call", { name: settingsUpdateName, arguments: { set: { recentLimit: 4 } } }))).json() as any;
      expect(written.result.structuredContent.values.recentLimit).toBe(4);
      const tools = await (await handler.fetch(rpc("tools/list"))).json() as any;
      expect(tools.result.tools.find((t: any) => t.name === settingsUpdateName).annotations.readOnlyHint).toBe(false);
      expect(tools.result.tools.find((t: any) => t.name === settingsReadName).annotations.readOnlyHint).toBe(true);
      expect(JSON.stringify(read)).not.toContain("alice");
      const invalid = await (await handler.fetch(rpc("tools/call", { name: settingsUpdateName, arguments: { set: { userId: "bob" } } }))).json() as any;
      expect(invalid.result?.isError || invalid.error).toBeTruthy();
      expect((await store.read()).recentLimit).toBe(4);
    } finally { await handler.close(); db.close(); }
  });
});
