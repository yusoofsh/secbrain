import { it, expect } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { modernHandler } from "../../src/mcp/modern";
import { defaults } from "../../src/workflows/settings";

it("forwards only omitted read defaults and preserves caller scope and original results", async () => {
  const seen: Record<string, unknown>[] = [];
  const preference = { ...defaults, recentLimit: 4, recallLimit: 2, defaultProject: "project-a", defaultLayer: "company" as const };
  const handler = modernHandler(() => {
    const server = new McpServer({ name: "preference-fixture", version: "1" });
    server.registerTool("list_recent", { inputSchema: { n: z.number().optional(), project: z.string().optional(), workspace: z.string().optional() } }, (args) => {
      seen.push(args);
      return { content: [{ type: "text", text: "original scoped read" }], _meta: { fixture: "unchanged" } };
    });
    return server;
  }, undefined, { read: () => Promise.resolve(preference), update: () => Promise.resolve(preference) });
  const call = async (args: Record<string, unknown>) => {
    const response = await handler.fetch(new Request("https://fixture.invalid/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Method": "tools/call", "Mcp-Name": "list_recent", "MCP-Protocol-Version": "2026-07-28" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_recent", arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }),
    }));
    expect(response.status).toBe(200);
    return await response.json() as { result: { content: Array<{ text: string }>; _meta: Record<string, unknown> } };
  };
  try {
    const first = await call({});
    expect(seen[0]).toEqual({ n: 4, project: "project-a", workspace: "company" });
    expect(first.result.content).toEqual([{ type: "text", text: "original scoped read" }]);
    expect(first.result._meta.fixture).toBe("unchanged");
    await call({ n: 1, project: "chosen", workspace: "personal" });
    expect(seen[1]).toEqual({ n: 1, project: "chosen", workspace: "personal" });
    expect(JSON.stringify(seen)).not.toContain("userId");
  } finally { await handler.close(); }
});
