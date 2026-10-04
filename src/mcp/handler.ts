import { isLegacyRequest } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { createMcpHandler } from "agents/mcp";
import type { Env } from "../env";
import { requireIdentityForMcp } from "../lib/identity";
import { ensureDbReady } from "../runtime/state";
import { buildMcpServer } from "./server";
import { isMcpToolsListRequest, sanitizeToolsListResponse } from "./sanitize";
import { secbrainEventHub } from "../events/secbrain";
import { modernHandler } from "./modern";

type McpExecutionContext = ExecutionContext & { props?: { userId?: string } };

export function createApiHandler() {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      ensureDbReady(ctx, env);
      const oauthUserId = (ctx as McpExecutionContext).props?.userId;
      const auth = await requireIdentityForMcp(request, env, oauthUserId);
      if (auth instanceof Response) return auth;
      const isToolsList = await isMcpToolsListRequest(request);
      if (request.method === "POST" && !(await isLegacyRequest(request))) {
        const eventsEnabled = Boolean(env.MCP_EVENTS_RELAY_URL && env.MCP_EVENTS_RELAY_TOKEN);
        const eventHandler = async (method: string, params: Record<string, unknown>) => {
          const { hub, state, prepare } = await secbrainEventHub(env);
          const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
          const parts = token.split(":");
          const owner = JSON.stringify(oauthUserId && parts.length === 3
            ? ["oauth", parts[0], parts[1]]
            : ["bearer", auth.userId, createHash("sha256").update(token).digest("hex")]);
          if (method === "events/subscribe") {
            await state.put("authorization", "auth:" + owner, {
              owner, token, userId: oauthUserId ?? auth.userId,
              oauth: Boolean(oauthUserId && parts.length === 3),
            });
            const workspace = (params.arguments as { workspace_id?: string } | undefined)?.workspace_id;
            if (workspace && [auth.personalWorkspaceId, ...auth.companyWorkspaceIds].includes(workspace)) await prepare(workspace);
          }
          return await hub.handle(method, params, owner);
        };
        const modern = modernHandler(() => buildMcpServer(env, ctx, auth), eventsEnabled ? eventHandler : undefined);
        try {
          const response = await modern.fetch(request);
          // No notification streams are advertised. Materialize before closing this per-request bridge.
          const result = new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
          result.headers.set("Cache-Control", "no-store");
          return isToolsList ? sanitizeToolsListResponse(result) : result;
        } finally { await modern.close(); }
      }
      const server = buildMcpServer(env, ctx, auth);
      const response = await createMcpHandler(server)(request, env, ctx);
      return isToolsList ? sanitizeToolsListResponse(response) : response;
    },
  };
}
