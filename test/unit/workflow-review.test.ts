import { it, expect, vi } from "vitest";
import { reviewProject, memoryId, memoryUri } from "../../src/workflows/review";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type FixtureRequest = { name: string; arguments: Record<string, unknown> };
it("asks for explicit scope and never reads on decline or invalid input", async () => {
  const read = vi.fn();
  expect((await reviewProject({}, undefined, read)).resultType).toBe("input_required");
  expect((await reviewProject({}, { memory_scope: { action: "decline" } }, read)).resultType).toBe("complete");
  expect(read).not.toHaveBeenCalled();
  await expect(reviewProject({}, { memory_scope: { action: "accept", content: { query: "x", workspace: "admin", project: "" } } }, read)).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});
it("rejects noncanonical resource paths before authorizing a source", () => {
  expect(memoryId(memoryUri("entry-1"))).toBe("entry-1");
  for (const uri of ["file:///etc/passwd", "secbrain://memory/../config", "secbrain://memory/a%2Fb", "secbrain://memory/x?token=secret"]) expect(() => memoryId(uri)).toThrow();
});
it("hashes full authorized content and marks unavailable sources without retrying or writing", async () => {
  const callTool = vi.fn((request: FixtureRequest) => {
    if (request.name === "recall") return Promise.resolve({ content: [{ type: "text", text: "bounded source coverage" }], _meta: { explorer: { cards: [{ id: "unavailable" }, { id: "a" }, { id: "b" }] } } });
    if (request.arguments.id === "unavailable") return Promise.resolve({ content: [{ type: "text", text: "No entry found with ID: unavailable" }] });
    return Promise.resolve({ content: [{ type: "text", text: "header\nID: " + String(request.arguments.id) + "\n" + "same full content".repeat(100) }] });
  });
  const result = await reviewProject({ query: "fixture", workspace: "personal", project: "" }, undefined, async read => read({ callTool } as unknown as Client)) as any;
  expect(result.structuredContent.changesApplied).toBe(false);
  expect(result.structuredContent.manifest.complete).toBe(false);
  expect(result.structuredContent.manifest.items[0].status).toBe("unavailable");
  expect(result.structuredContent.manifest.items[1].previewTruncated).toBe(true);
  expect(result.structuredContent.duplicateCandidates[0].ids).toEqual(["a", "b"]);
  expect(callTool.mock.calls.map(call => call[0].name)).toEqual(["recall", "get", "get", "get"]);
});
