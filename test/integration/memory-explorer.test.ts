import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp/server";
import { createApiHandler } from "../../src/mcp/handler";
import { modernHandler } from "../../src/mcp/modern";
import { memoryCards, registerMemoryExplorer, MEMORY_EXPLORER_URI } from "../../src/ui/memory-explorer";
import { makeTestEnv } from "../helpers/make-env";
const ctx = { waitUntil(p: Promise<unknown>) { p.catch(() => {}); } } as ExecutionContext;
const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
function request(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const name = params.name ?? params.uri;
  return new Request("https://fixture.invalid/mcp", { method: "POST", headers: {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    "Mcp-Method": method, "MCP-Protocol-Version": "2026-07-28",
    ...(typeof name === "string" ? { "Mcp-Name": name } : {}), ...headers,
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }) });
}
describe("Memory Explorer", () => {
  it("bounds authorized preview data and omits unrelated fields", () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ id: String(i), content: "x".repeat(1000), workspace: "personal", createdAt: 1, secret: "not-a-projected-field" }));
    const cards = memoryCards(rows);
    expect(cards).toHaveLength(10);
    expect(cards.every(card => card.preview.length === 600 && card.truncated)).toBe(true);
    expect(JSON.stringify(cards)).not.toContain("not-a-projected-field");
  });
  it("preserves the fifteen existing tool names and adds a static private UI resource", async () => {
    const source = buildMcpServer(makeTestEnv(), ctx);
    const client = new Client({ name: "fixture", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await source.connect(a); await client.connect(b);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(15);
      const tool = tools.find(t => t.name === "list_recent")!;
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect((tool._meta?.ui as { resourceUri: string }).resourceUri).toBe(MEMORY_EXPLORER_URI);
      expect(tool._meta?.["openai/ui"]).toEqual({ entrypoints: [{ type: "global" }, { type: "thread" }] });
      const resource = await client.readResource({ uri: MEMORY_EXPLORER_URI });
      expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
      expect((resource.contents[0] as { text: string }).text).toContain("ui/update-model-context");
      expect((resource.contents[0] as { text: string }).text).not.toContain("innerHTML");
    } finally { await client.close(); await source.close(); }
  });
  it("forwards real UI resources through the modern SDK and rejects invalid routing before events", async () => {
    const events = vi.fn().mockResolvedValue({ events: [] });
    const handler = modernHandler(() => {
      const source = new McpServer({ name: "fixture", version: "1" });
      registerMemoryExplorer(source); return source;
    }, events);
    try {
      const response = await handler.fetch(request("resources/read", { uri: MEMORY_EXPLORER_URI }));
      expect(response.status).toBe(200);
      const payload = await response.json() as any;
      expect(payload.result.resultType).toBe("complete");
      expect(payload.result.contents[0].text).toContain("Memory Explorer");
      expect(payload.result.contents[0]._meta.ui.csp.connectDomains).toEqual([]);
      const bad = await handler.fetch(request("events/subscribe", {}, { "Mcp-Method": "tools/call" }));
      expect(bad.status).toBe(400); expect(events).not.toHaveBeenCalled();
      const valid = await handler.fetch(request("events/list"));
      expect(valid.status).toBe(200); expect(events).toHaveBeenCalledTimes(1);
    } finally { await handler.close(); }
  });
  it("keeps unauthenticated resource requests outside the data boundary", async () => {
    const response = await createApiHandler().fetch(request("resources/read", { uri: MEMORY_EXPLORER_URI }), makeTestEnv(), ctx);
    expect(response.status).toBe(401);
  });
});
