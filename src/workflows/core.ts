import { createHash } from "node:crypto";
export type WorkflowSkill = { name: string; description: string; body: string };
export function skillCatalog(namespace: string, definitions: readonly WorkflowSkill[]) {
  if (!/^[a-z0-9-]+$/.test(namespace) || definitions.length > 5) throw new Error("Invalid bounded skill catalog");
  const seen = new Set<string>();
  const files = definitions.map(d => {
    if (!/^[a-z0-9-]+$/.test(d.name) || seen.has(d.name)) throw new Error("Invalid or duplicate skill name");
    seen.add(d.name);
    const text = `---\nname: ${d.name}\ndescription: ${JSON.stringify(d.description)}\n---\n\n# ${d.name}\n\n${d.body}\n`;
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error("Skill too large");
    const uri = `skill://${namespace}/${d.name}/SKILL.md`;
    return { uri, text, frontmatter: { name: d.name, description: d.description }, digest: "sha256:" + createHash("sha256").update(text, "utf8").digest("hex") };
  });
  const manifest = (f: typeof files[number]) => ({ uri: f.uri, frontmatter: f.frontmatter, resources: [{ uri: f.uri, digest: f.digest }] });
  return {
    files,
    list(cursor?: string) { if (cursor !== undefined) throw new Error("Invalid cursor"); return { skills: files.map(manifest) }; },
    get(uri: string) { const f = files.find(f => f.uri === uri); if (!f) throw new Error("Unknown skill"); return { skill: manifest(f) }; },
    read(uri: string) { const f = files.find(f => f.uri === uri); if (!f) throw new Error("Unknown skill resource"); return { contents: [{ uri, mimeType: "text/markdown", text: f.text }] }; },
  };
}
/** This is a wire hint, never an authorization decision or a content cache. */
export function privateResult<T extends object>(value: T, ttlMs = 0) {
  if (!Number.isFinite(ttlMs)) throw new Error("Invalid cache lifetime");
  return { ...value, ttlMs: Math.floor(Math.max(0, Math.min(30000, ttlMs))), cacheScope: "private" as const };
}
/** Forward only validated W3C identifiers; never arbitrary baggage or vendor state. */
export function traceMeta(meta: unknown): Record<string, string> {
  if (!meta || typeof meta !== "object") return {};
  const trace = (meta as Record<string, unknown>).traceparent;
  if (typeof trace !== "string" || !/^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/.test(trace)) return {};
  const parts = trace.split("-");
  if (/^0+$/.test(parts[1]!) || /^0+$/.test(parts[2]!)) return {};
  return { traceparent: trace };
}
export function forwardMeta(source: unknown, context: unknown): Record<string, unknown> {
  const kept = source && typeof source === "object" && !Array.isArray(source) ? { ...source as Record<string, unknown> } : {};
  delete kept.traceparent; delete kept.tracestate; delete kept.baggage;
  return { ...kept, ...traceMeta(context) };
}
export function observedManifest<T>(kind: string, items: T[], complete: boolean, warnings: string[] = []) {
  return { kind, observedAt: new Date().toISOString(), complete: complete && items.length <= 50, items: items.slice(0, 50), warnings, snapshot: false, requiresFreshAuthorization: true };
}
