import type { Env } from "../../src/env";
import { it, expect } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { resetDatabaseInit } from "../../src/db/init";
import { apiHandler } from "../../src/mcp/handler";
it("modern discovery and ordinary tools coexist on the authenticated HTTP edge", async () => {
  resetDatabaseInit();
  const db = makeSqliteD1();
  const env = makeTestEnv(undefined, { DB: db.db as unknown as Env["DB"] });
  const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
  const call = (method: string) =>
    apiHandler.fetch(
      new Request("https://example.test/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Method": method,
          "MCP-Protocol-Version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
      env,
      ctx,
    );
  try {
    const discover = await call("server/discover");
    expect(discover.status).toBe(200);
    expect(((await discover.json()) as any).result.supportedVersions).toContain(
      "2026-07-28",
    );
    const tools = await call("tools/list");
    expect(tools.status).toBe(200);
    const text = await tools.text();
    expect(text).toContain('"tools"');
    expect(text).not.toContain('"error"');
  } finally {
    db.close();
    resetDatabaseInit();
  }
});
