import { callbackUrl, type WebhookPost } from "./core.js";
/** The configured relay performs fresh DNS validation and pins the TLS connection. */
export function relayPost(endpoint: string, token: string): WebhookPost {
  const target = callbackUrl(endpoint);
  if (!token || /[\r\n]/.test(token))
    throw new Error("Webhook relay authentication is required");
  return async (url, headers, body) => {
    const response = await fetch(target, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, headers, body }),
    });
    if (!response.ok) throw new Error("Webhook relay failed");
    const result = (await response.json()) as {
      status: number;
      challenge?: string;
    };
    if (!Number.isInteger(result.status))
      throw new Error("Invalid webhook relay receipt");
    return { status: result.status, challenge: result.challenge };
  };
}
