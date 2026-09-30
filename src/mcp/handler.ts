import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHash } from "node:crypto";
import { createMcpHandler } from "agents/mcp";
import type { Env } from "../env";
import { requireIdentityForMcp } from "../lib/identity";
import { ensureDbReady } from "../runtime/state";
import { buildMcpServer } from "./server";
import { isMcpToolsListRequest, sanitizeToolsListResponse } from "./sanitize";
import { secbrainEventHub } from "../events/secbrain";
import { EventError } from "../events/core";

type McpExecutionContext = ExecutionContext & { props?: { userId?: string } };

export function createApiHandler() {
  return {
    async fetch(
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response> {
      ensureDbReady(ctx, env);
      const oauthUserId = (ctx as McpExecutionContext).props?.userId;
      const auth = await requireIdentityForMcp(request, env, oauthUserId);
      if (auth instanceof Response) return auth;
      if (request.method === "POST") {
        let body:
          | { id?: unknown; method?: string; params?: Record<string, unknown> }
          | undefined;
        try {
          body = await request.clone().json();
        } catch {
          /* SDK owns parse errors */
        }
        if (
          env.MCP_EVENTS_RELAY_URL &&
          env.MCP_EVENTS_RELAY_TOKEN &&
          body?.method?.startsWith("events/")
        ) {
          try {
            const { hub, state, prepare } = await secbrainEventHub(env);
            const token =
              request.headers
                .get("Authorization")
                ?.replace(/^Bearer\s+/i, "") ?? "";
            const parts = token.split(":");
            const owner = JSON.stringify(
              oauthUserId && parts.length === 3
                ? ["oauth", parts[0], parts[1]]
                : [
                    "bearer",
                    auth.userId,
                    createHash("sha256").update(token).digest("hex"),
                  ],
            );
            if (body.method === "events/subscribe") {
              await state.put("authorization", "auth:" + owner, {
                owner,
                token,
                userId: oauthUserId ?? auth.userId,
                oauth: Boolean(oauthUserId && parts.length === 3),
              });
              const workspace = (
                body.params?.arguments as { workspace_id?: string }
              )?.workspace_id;
              if (
                workspace &&
                [
                  auth.personalWorkspaceId,
                  ...auth.companyWorkspaceIds,
                ].includes(workspace)
              )
                await prepare(workspace);
            }
            const result = await hub.handle(
              body.method,
              body.params ?? {},
              owner,
            );
            return Response.json(
              { jsonrpc: "2.0", id: body.id ?? null, result },
              { headers: { "Cache-Control": "no-store" } },
            );
          } catch (error) {
            const e =
              error instanceof EventError
                ? error
                : new EventError(-32603, "Event operation failed");
            return Response.json({
              jsonrpc: "2.0",
              id: body.id ?? null,
              error: {
                code: e.code,
                message: e.message,
                ...(e.reason ? { data: { reason: e.reason } } : {}),
              },
            });
          }
        }
        if (body?.method === "server/discover") {
          // Keep legacy SDK tools working, and expose the modern webhook extension at the authenticated edge.
          return Response.json({
            jsonrpc: "2.0",
            id: body.id ?? null,
            result: {
              resultType: "complete",
              supportedVersions: ["2026-07-28"],
              capabilities: {
                tools: {},
                ...(env.MCP_EVENTS_RELAY_URL && env.MCP_EVENTS_RELAY_TOKEN
                  ? { events: {} }
                  : {}),
              },
            },
          });
        }
      }
      const server = buildMcpServer(env, ctx, auth);
      if (request.method === "POST") {
        const rpc = (await request
          .clone()
          .json()
          .catch(() => undefined)) as
          | { id?: unknown; method?: string; params?: Record<string, any> }
          | undefined;
        if (
          rpc &&
          (rpc.params?._meta?.["io.modelcontextprotocol/protocolVersion"] ===
            "2026-07-28" ||
            request.headers.get("MCP-Protocol-Version") === "2026-07-28")
        ) {
          const client = new Client({
            name: "secbrain-modern-bridge",
            version: "1",
          });
          const [a, b] = InMemoryTransport.createLinkedPair();
          try {
            await server.connect(a);
            await client.connect(b);
            let result: unknown;
            if (rpc.method === "tools/list")
              result = await client.listTools(rpc.params, {
                signal: request.signal,
              });
            else if (rpc.method === "tools/call")
              result = await client.callTool(
                rpc.params as {
                  name: string;
                  arguments?: Record<string, unknown>;
                },
                undefined,
                { signal: request.signal },
              );
            else if (rpc.method === "ping") result = {};
            else throw new EventError(-32601, "Unknown method");
            const response = Response.json(
              {
                jsonrpc: "2.0",
                id: rpc.id ?? null,
                result: {
                  ...(result as object),
                  resultType: "complete",
                  _meta: {
                    "io.modelcontextprotocol/serverInfo": {
                      name: "second-brain",
                      version: "3.7.0",
                    },
                  },
                },
              },
              { headers: { "Cache-Control": "no-store" } },
            );
            return rpc.method === "tools/list"
              ? sanitizeToolsListResponse(response)
              : response;
          } catch (error) {
            const e = error as { code?: number };
            return Response.json({
              jsonrpc: "2.0",
              id: rpc.id ?? null,
              error: {
                code: e.code ?? -32603,
                message:
                  e.code === -32601 ? "Unknown method" : "MCP request failed",
              },
            });
          } finally {
            await client.close();
            await server.close();
          }
        }
      }
      const isToolsList = await isMcpToolsListRequest(request);
      const response = await createMcpHandler(server)(request, env, ctx);
      return isToolsList ? sanitizeToolsListResponse(response) : response;
    },
  };
}

export const apiHandler = createApiHandler();
