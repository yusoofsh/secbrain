import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { callbackUrl, type WebhookPost } from "./core.js";

const blocked4 = new BlockList(),
  blocked6 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked4.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked6.addSubnet(net, bits, "ipv6");
export function publicAddress(ip: string): boolean {
  const family = isIP(ip);
  return (
    family !== 0 &&
    (family === 4 || /^[23][0-9a-f]{3}:/i.test(ip)) &&
    !(family === 4 ? blocked4 : blocked6).check(
      ip,
      family === 4 ? "ipv4" : "ipv6",
    )
  );
}
/** Resolve afresh for EVERY attempt and connect to that exact address, preserving TLS SNI. */
export const webhookPost: WebhookPost = async (url, headers, body) => {
  const deadline = Date.now() + 10000;
  const u = new URL(callbackUrl(url)),
    hostname = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await new Promise<{ address: string; family: number }[]>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Callback DNS timeout")),
            5000,
          );
          lookup(hostname, { all: true })
            .then(resolve, reject)
            .finally(() => clearTimeout(timer));
        },
      );
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new Error("Non-public callback destination");
  const target = addresses[0];
  if (!target) throw new Error("No callback address");
  return new Promise((resolve, reject) => {
    const req = request(
      u.href,
      {
        method: "POST",
        headers,
        agent: false,
        servername: isIP(hostname) ? undefined : hostname,
        lookup: (_host, options, cb) => {
          if (typeof options === "object" && options.all)
            (
              cb as unknown as (
                error: null,
                addresses: { address: string; family: number }[],
              ) => void
            )(null, [target]);
          else cb(null, target.address, target.family);
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16384) {
            response.destroy();
            reject(new Error("Callback response exceeds limit"));
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          let challenge: string | undefined;
          try {
            challenge = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            ).challenge;
          } catch {
            /* receipt may have no body */
          }
          resolve({ status: response.statusCode ?? 0, challenge });
        });
      },
    );
    const timeout = setTimeout(
      () => req.destroy(new Error("Callback timeout")),
      Math.max(1, deadline - Date.now()),
    );
    req.on("error", reject);
    req.on("close", () => clearTimeout(timeout));
    req.end(body);
  });
};
