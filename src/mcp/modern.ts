import { createMcpHandler, Server, ProtocolError, type ListToolsResult, type CallToolResult } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { EventError } from "../events/core";

type EventHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;
/** Existing scoped handlers own data access; the maintained SDK owns the wire protocol. */
export function modernHandler(factory: () => McpServer, eventHandler?: EventHandler) {
  async function delegated<T>(read: (client: Client) => Promise<T>): Promise<T> {
    const source = factory(); const client = new Client({ name: "secbrain-compatibility", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try { await source.connect(a); await client.connect(b); return await read(client); }
    finally { await client.close(); await source.close(); }
  }
  return createMcpHandler(() => {
    const server = new Server({ name: "second-brain", version: "3.7.0" }, {
      capabilities: { tools: {}, resources: {}, ...(eventHandler ? { events: {} } : {}) },
    });
    server.setRequestHandler("tools/list", async (request, ctx) => ({
      ...await delegated(c => c.listTools(request.params, { signal: ctx.mcpReq.signal })) as unknown as ListToolsResult, resultType: "complete",
    }));
    server.setRequestHandler("tools/call", async (request, ctx) => ({
      ...await delegated(c => c.callTool(request.params, undefined, { signal: ctx.mcpReq.signal })) as unknown as CallToolResult, resultType: "complete",
    }));
    server.setRequestHandler("resources/list", async (request, ctx) => ({
      ...await delegated(c => c.listResources(request.params, { signal: ctx.mcpReq.signal })), resultType: "complete",
    }));
    server.setRequestHandler("resources/templates/list", async (request, ctx) => ({
      ...await delegated(c => c.listResourceTemplates(request.params, { signal: ctx.mcpReq.signal })), resultType: "complete",
    }));
    server.setRequestHandler("resources/read", async (request, ctx) => ({
      ...await delegated(c => c.readResource(request.params, { signal: ctx.mcpReq.signal })), resultType: "complete",
    }));
    if (eventHandler) for (const method of ["events/list", "events/subscribe", "events/unsubscribe"]) {
      server.setRequestHandler(method, {
        params: z.record(z.string(), z.unknown()), result: z.object({ resultType: z.literal("complete") }).passthrough(),
      }, async params => {
        try { return { ...z.record(z.string(), z.unknown()).parse(await eventHandler(method, params)), resultType: "complete" as const }; }
        catch (error) { if (error instanceof EventError) throw new ProtocolError(error.code, error.message, error.reason ? { reason: error.reason } : undefined); throw new ProtocolError(-32603, "Event operation failed"); }
      });
    }
    return server;
  }, { legacy: "reject" });
}
