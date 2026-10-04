import { it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { modernHandler } from "../../src/mcp/modern";
import { registerWorkflowResources } from "../../src/workflows/resources";
function rpc(method: string, params: Record<string, unknown> = {}) {
  return new Request("https://fixture.invalid/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(typeof (params.name ?? params.uri) === "string" ? { "mcp-name": String(params.name ?? params.uri) } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} }, extensions: { "io.modelcontextprotocol/skills": {} } } } } }) });
}
it("keeps MRTR decisions and authorization checks in the real modern request path", async () => {
  const calls: string[] = [];
  const handler = modernHandler(() => {
    const server = new McpServer({ name: "fixture", version: "1" }); registerWorkflowResources(server);
    server.registerTool("get", { inputSchema: {} }, () => { calls.push("get"); return { content: [{ type: "text", text: "No entry found with ID: private" }] }; });
    return server;
  });
  try {
    const first = await (await handler.fetch(rpc("tools/call", { name: "review_project_memory", arguments: {} }))).json() as any;
    expect(first.result.resultType).toBe("input_required"); expect(calls).toEqual([]);
    const declined = await (await handler.fetch(rpc("tools/call", { name: "review_project_memory", arguments: {}, inputResponses: { memory_scope: { action: "decline" } } }))).json() as any;
    expect(declined.result.content[0].text).toContain("cancelled"); expect(calls).toEqual([]);
    const skills = await (await handler.fetch(rpc("skills/list"))).json() as any;
    expect(skills.result.skills).toHaveLength(2);
    const forbidden = await (await handler.fetch(rpc("resources/read", { uri: "secbrain://memory/private" }))).json() as any;
    expect(forbidden.error.code).toBe(-32602); expect(calls).toEqual(["get"]);
  } finally { await handler.close(); }
});
