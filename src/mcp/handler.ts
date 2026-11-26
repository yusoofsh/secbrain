import { isLegacyRequest } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { createMcpHandler } from "agents/mcp";
import type { Env } from "../env";
import { extractToken, requireIdentityForMcp } from "../lib/identity";
import { ensureDbReady } from "../runtime/state";
import { buildMcpServer } from "./server";
import type { McpClientProps } from "./client-label";
import { isMcpToolsListRequest, sanitizeToolsListResponse } from "./sanitize";
import { secbrainEventHub } from "../events/secbrain";
import { modernHandler } from "./modern";
import { createPreferenceStore } from "../workflows/settings";
import { rewriteDailyLimitToolErrors } from "./daily-limit-response";

type McpExecutionContext = ExecutionContext & { props?: { userId?: string } & McpClientProps };

export function createApiHandler() {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      ensureDbReady(ctx, env);
      const props = (ctx as McpExecutionContext).props;
      const oauthUserId = props?.userId;
      // R3 (budget audit, MAJOR): identity resolution is itself a D1 read, so a spent daily D1
      // cap throws HERE, before any tool runs. Left to propagate, it reaches the caller through
      // src/index.ts's top-level catch (the "top-level fetch handler" for both REST and MCP).
      const auth = await requireIdentityForMcp(request, env, props?.userId);
      if (auth instanceof Response) return auth;
      // BE-5: ctx.props carries the OAuth grant's own clientName (or via:"token"
      // for a static bearer, src/index.ts's resolveExternalToken), read once here
      // per request and handed to every write tool through resolveClientLabel.
      const clientProps: McpClientProps | undefined = props
        ? { clientId: props.clientId, clientName: props.clientName, via: props.via }
        : undefined;
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
        const modern = modernHandler(() => buildMcpServer(env, ctx, auth, clientProps, extractToken(request)), eventsEnabled ? eventHandler : undefined, createPreferenceStore(env.DB, auth.userId));
        try {
          const response = await modern.fetch(request);
          // No notification streams are advertised. Materialize before closing this per-request bridge.
          const result = new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
          result.headers.set("Cache-Control", "no-store");
          return isToolsList ? sanitizeToolsListResponse(result) : result;
        } finally { await modern.close(); }
      }
      const server = buildMcpServer(env, ctx, auth, clientProps, extractToken(request));
      const response = await createMcpHandler(server)(request, env, ctx);
      // R3 continued: a D1 cap hit INSIDE a tool call never reaches the block above — the SDK's
      // own dispatch already caught it and turned it into a normal-looking CallToolResult whose
      // text is the raw D1 error ("D1_ERROR: ... daily row read/write limit ..."), see
      // node_modules/@modelcontextprotocol/sdk .../server/mcp.js's tool-call catch. This is the
      // one place that response is visible to rewrite it into the named MCP sentence.
      const withDailyLimit = await rewriteDailyLimitToolErrors(response);
      return isToolsList ? sanitizeToolsListResponse(withDailyLimit) : withDailyLimit;
    },
  };
}

export const apiHandler = createApiHandler();
