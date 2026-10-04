import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { inputRequired, ProtocolError } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { observedManifest } from "./core";

export const reviewChoices = z.object({ query: z.string().trim().min(1).max(500), workspace: z.enum(["personal", "company"]), project: z.string().max(80).regex(/^[a-z0-9_-]*$/) }).strict();
export const reviewTool = {
  name: "review_project_memory", title: "Review project memories",
  description: "Prepare a bounded read-only review packet from authorized memories. Ask for subject, workspace and project when missing. Fetch up to five full sources, retain exact content digests and reference URIs, identify only exact duplicates, and require a separate approved operation for any correction.",
  inputSchema: { type: "object" as const, properties: { query: { type: "string", maxLength: 500 }, workspace: { type: "string", enum: ["personal", "company"] }, project: { type: "string", maxLength: 80 } }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
type Delegate = <T>(read: (client: Client) => Promise<T>) => Promise<T>;
export async function reviewProject(args: unknown, responses: Record<string, unknown> | undefined, read: Delegate) {
  const input = z.object({ query: z.string().max(500).optional(), workspace: z.enum(["personal", "company"]).optional(), project: z.string().max(80).optional() }).strict().parse(args ?? {});
  const response = responses?.memory_scope as { action?: string; content?: unknown } | undefined;
  if (response && (response.action === "decline" || response.action === "cancel")) return { resultType: "complete" as const, content: [{ type: "text" as const, text: "Memory review cancelled. No memories were read or changed." }] };
  const parsed = reviewChoices.safeParse(response?.action === "accept" ? response.content : input);
  if (!parsed.success) {
    if (response) throw new ProtocolError(-32602, "Invalid memory review choices");
    return inputRequired({ inputRequests: { memory_scope: inputRequired.elicit({ message: "Choose the review subject and authorized layer. Leave project blank for the selected layer without a project filter.", requestedSchema: {
      type: "object", properties: { query: { type: "string", title: "Subject or question", minLength: 1, maxLength: 500 }, workspace: { type: "string", title: "Layer", oneOf: [{ const: "personal", title: "Personal" }, { const: "company", title: "Company" }] }, project: { type: "string", title: "Project slug or empty", maxLength: 80 } }, required: ["query", "workspace", "project"], additionalProperties: false,
    } }) } });
  }
  const choices = parsed.data;
  return await read(async client => {
    const recalled = CallToolResultSchema.parse(await client.callTool({ name: "recall", arguments: { query: choices.query, workspace: choices.workspace, ...(choices.project ? { project: choices.project } : {}), topK: 5 } }));
    if (recalled.isError) return { resultType: "complete" as const, isError: true, content: [{ type: "text" as const, text: "The authorized memory search failed. No changes were made." }] };
    const meta = recalled._meta as { explorer?: { cards?: Array<{ id: string }> } } | undefined;
    const ids = [...new Set((meta?.explorer?.cards ?? []).slice(0, 5).map(card => card.id))];
    const sources: Array<{ id: string; status: string; uri: string; digest?: string; preview?: string; previewTruncated?: boolean }> = [];
    for (const id of ids) {
      const result = CallToolResultSchema.parse(await client.callTool({ name: "get", arguments: { id } }));
      const text = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      if (result.isError || !text.includes("ID: " + id + "\n")) { sources.push({ id, status: "unavailable", uri: memoryUri(id) }); continue; }
      const body = text.slice(text.indexOf("ID: " + id + "\n") + ("ID: " + id + "\n").length);
      const digest = "sha256:" + createHash("sha256").update(body).digest("hex");
      sources.push({ id, status: "read", uri: memoryUri(id), digest, preview: body.slice(0, 1200), previewTruncated: body.length > 1200 });
    }
    const duplicates = sources.flatMap((source, i) => sources.slice(i + 1).filter(other => source.digest && other.digest === source.digest).map(other => ({ ids: [source.id, other.id], reason: "Exact full-source content matches. This is a review candidate, not permission to delete." })));
    const manifest = observedManifest("memory-review", sources, false, ["This is a bounded relevance-selected sample, not a complete corpus audit.", "Age, apparent inconsistency and similar previews do not establish that a memory is wrong."]);
    const packet = { choices, manifest, duplicateCandidates: duplicates, changesApplied: false, nextAction: "Review original sources. Re-read access and content immediately before a separately approved write.", recallNotes: recalled.content };
    return { resultType: "complete" as const, structuredContent: packet, content: [{ type: "text" as const, text: JSON.stringify(packet) }] };
  });
}
export function memoryUri(id: string) { return "secbrain://memory/" + encodeURIComponent(id); }
export function memoryId(uri: string) {
  if (!/^secbrain:\/\/memory\/[A-Za-z0-9_-]{1,100}$/.test(uri)) throw new ProtocolError(-32602, "Invalid memory resource");
  return uri.slice("secbrain://memory/".length);
}
