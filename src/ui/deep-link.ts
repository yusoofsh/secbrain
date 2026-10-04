/** Accept local application identities, never a URL to fetch. */
export function appRoute(value: unknown): { kind: "course" | "memory"; id: string } | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as { url?: unknown }).url;
  if (typeof raw !== "string" || raw.length > 300 || !raw.startsWith("/") || raw.startsWith("//")) return null;
  const match = /^\/(course|memory)\/([A-Za-z0-9_-]{1,100})$/.exec(raw);
  if (!match) return null;
  if (match[1] === "course" && !/^[1-9][0-9]{0,14}$/.test(match[2]!)) return null;
  return { kind: match[1] as "course" | "memory", id: match[2]! };
}
