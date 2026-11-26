#!/usr/bin/env node
/**
 * Make the Worker's cron triggers match wrangler.jsonc.
 *
 * Why this exists: `wrangler deploy` normally sets the triggers itself, but on
 * this account its schedule request is refused once the account's cron total
 * reaches the Workers Free limit of five, even when the requested set is the
 * same five or fewer. The deploy itself has already replaced the Worker code
 * by then, so the run fails with "Trigger configuration ... only partially
 * updated" (code 10072) while the live Worker is fine. A bare-array PUT to the
 * same endpoint succeeds in that state, which is what this script sends.
 *
 * The deploy workflow calls this only after such a partial update, so the
 * config in wrangler.jsonc stays the single source of truth and a deploy never
 * reports success with the wrong schedules.
 *
 * Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Strip // and /* *\/ comments, leaving string contents untouched. */
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

export function readConfig(root = ROOT) {
  const raw = readFileSync(resolve(root, "wrangler.jsonc"), "utf8");
  const config = JSON.parse(stripJsonComments(raw));
  const crons = config?.triggers?.crons ?? [];
  if (typeof config.name !== "string" || !config.name) throw new Error("wrangler.jsonc has no Worker name");
  if (!Array.isArray(crons) || crons.some((c) => typeof c !== "string")) {
    throw new Error("wrangler.jsonc triggers.crons must be an array of cron strings");
  }
  return { name: config.name, crons: [...new Set(crons)] };
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");

  const { name, crons } = readConfig();
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}/schedules`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const read = async () => {
    const response = await fetch(url, { headers });
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(`reading schedules failed: ${JSON.stringify(body.errors)}`);
    return (body.result?.schedules ?? []).map((s) => s.cron).sort();
  };

  const wanted = [...crons].sort();
  const before = await read();
  if (JSON.stringify(before) === JSON.stringify(wanted)) {
    console.log(`cron triggers already match wrangler.jsonc (${wanted.join(", ") || "none"})`);
    return;
  }

  const response = await fetch(url, {
    method: "PUT",
    headers,
    // The endpoint takes a bare array here; {"schedules": [...]} is rejected.
    body: JSON.stringify(wanted.map((cron) => ({ cron }))),
  });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(`setting schedules failed: ${JSON.stringify(body.errors)}`);

  const after = await read();
  if (JSON.stringify(after) !== JSON.stringify(wanted)) {
    throw new Error(`schedules did not converge: wanted ${wanted.join(", ")}, got ${after.join(", ")}`);
  }
  console.log(`cron triggers set from wrangler.jsonc (${wanted.join(", ") || "none"})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
