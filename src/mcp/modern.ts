import { reviewProject, reviewTool, memoryId } from "../workflows/review";
import { workflowSkills } from "../workflows/skills";
import { privateResult, forwardMeta } from "../workflows/core";
import { settingsReadName, settingsUpdateName, settingsTools, settingsCall, mergeDefaults, type PreferenceStore } from "../workflows/settings";
import { createMcpHandler, Server, ProtocolError, type ListToolsResult, type CallToolResult } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { EventError } from "../events/core";

type EventHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;
/** Existing scoped handlers own data access; the maintained SDK owns the wire protocol. */
export function modernHandler(factory: () => McpServer, eventHandler?: EventHandler, preferences?: PreferenceStore) {
  async function delegated<T>(read: (client: Client) => Promise<T>): Promise<T> {
    const source = factory(); const client = new Client({ name: "secbrain-compatibility", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try { await source.connect(a); await client.connect(b); return await read(client); }
    finally { await client.close(); await source.close(); }
  }
  return createMcpHandler(() => {
    const server = new Server({ name: "second-brain", version: "3.7.0" }, {
      capabilities: { extensions: { "io.modelcontextprotocol/skills": {}, ...(preferences ? { "openai/settings": { readTool: settingsReadName, updateTool: settingsUpdateName } } : {}) }, tools: {}, resources: {}, ...(eventHandler ? { events: {} } : {}) },
    });
    server.setRequestHandler("skills/list", { params: z.object({ cursor: z.string().optional() }).strict(), result: z.object({}).passthrough() }, params => {
      try { return { ...privateResult(workflowSkills.list(params.cursor), 30000), resultType: "complete" }; }
      catch { throw new ProtocolError(-32602, "Invalid skill request"); }
    });
    server.setRequestHandler("skills/get", { params: z.object({ uri: z.string().max(300) }).strict(), result: z.object({}).passthrough() }, params => {
      try { return { ...privateResult(workflowSkills.get(params.uri), 30000), resultType: "complete" }; }
      catch { throw new ProtocolError(-32602, "Unknown skill"); }
    });
    server.setRequestHandler("tools/list", async (request, ctx) => {
      const result = await delegated(c => c.listTools({ ...request.params, _meta: forwardMeta(request.params?._meta, ctx.mcpReq._meta) }, { signal: ctx.mcpReq.signal }));
      return { ...result, tools: [...result.tools, reviewTool, ...(preferences ? settingsTools : [])] as unknown as ListToolsResult["tools"], ttlMs: 0, cacheScope: "private", resultType: "complete" };
    });
    server.setRequestHandler("tools/call", async (request, ctx) => {
      if (preferences && (request.params.name === settingsReadName || request.params.name === settingsUpdateName)) return settingsCall(request.params.name, request.params.arguments, preferences);
      if (request.params.name === reviewTool.name) return reviewProject(request.params.arguments, ctx.mcpReq.inputResponses, delegated);
      let args = request.params.arguments;
      if (preferences && (request.params.name === "list_recent" || request.params.name === "recall")) {
        try { args = mergeDefaults(request.params.name, args, await preferences.read()); }
        catch { return { resultType: "complete", isError: true, content: [{ type: "text", text: "Read preferences are unavailable. Read the current preferences before retrying." }] }; }
      }
      return { ...await delegated(c => c.callTool({ ...request.params, arguments: args, _meta: forwardMeta(request.params._meta, ctx.mcpReq._meta) }, undefined, { signal: ctx.mcpReq.signal })) as unknown as CallToolResult, resultType: "complete" };
    });
    server.setRequestHandler("resources/list", async (request, ctx) => ({
      ...await delegated(c => c.listResources({ ...request.params, _meta: forwardMeta(request.params?._meta, ctx.mcpReq._meta) }, { signal: ctx.mcpReq.signal })), ttlMs: 0, cacheScope: "private", resultType: "complete",
    }));
    server.setRequestHandler("resources/templates/list", async (request, ctx) => {
      const result = await delegated(c => c.listResourceTemplates({ ...request.params, _meta: forwardMeta(request.params?._meta, ctx.mcpReq._meta) }, { signal: ctx.mcpReq.signal }));
      return { ...result, resourceTemplates: [...result.resourceTemplates, { name: "authorized-memory", uriTemplate: "secbrain://memory/{id}", mimeType: "text/plain", description: "Re-read an authorized memory through the original get tool" }], ttlMs: 0, cacheScope: "private", resultType: "complete" };
    });
    server.setRequestHandler("resources/read", async (request, ctx) => {
      if (request.params.uri.startsWith("secbrain://")) {
        const id = memoryId(request.params.uri);
        const result = await delegated(c => c.callTool({ name: "get", arguments: { id }, _meta: forwardMeta(request.params._meta, ctx.mcpReq._meta) }, undefined, { signal: ctx.mcpReq.signal }));
        const text = Array.isArray(result.content) ? result.content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";
        if (result.isError || !text.includes("ID: " + id + "\n")) throw new ProtocolError(-32602, "Memory resource is not available");
        return { contents: [{ uri: request.params.uri, mimeType: "text/plain", text }], ttlMs: 0, cacheScope: "private", resultType: "complete" };
      }
      return { ...await delegated(c => c.readResource({ ...request.params, _meta: forwardMeta(request.params._meta, ctx.mcpReq._meta) }, { signal: ctx.mcpReq.signal })), ttlMs: 0, cacheScope: "private", resultType: "complete" };
    });
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
