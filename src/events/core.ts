import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { Buffer } from "node:buffer";

/** Transport-independent implementation of the ChatGPT MCP Events webhook draft. */
export interface EventDefinition {
  name: string;
  description: string;
  delivery: ["webhook"];
  inputSchema: {
    type: "object";
    properties: Record<string, { type: "string" }>;
    required?: string[];
    additionalProperties: false;
  };
  payloadSchema: Record<string, unknown>;
}
export interface EventRecord {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
  cursor: null;
}
export interface Subscription {
  id: string;
  owner: string;
  name: string;
  arguments: Record<string, string>;
  url: string;
  secret: string;
  oldSecret?: string;
  rotateUntil?: number;
  expires: number;
  verifiedUntil: number;
  generation: string;
  since?: number;
}
export interface Delivery {
  id: string;
  subscription: string;
  generation: string;
  event: EventRecord;
  attempts: number;
  due: number;
}
export interface EventStore {
  subscriptions(): Promise<Subscription[]>;
  putSubscription(s: Subscription): Promise<void>;
  deleteSubscription(id: string): Promise<void>;
  deliveries(): Promise<Delivery[]>;
  putDelivery(d: Delivery): Promise<void>;
  deleteDelivery(id: string): Promise<void>;
}
export interface PostResult {
  status: number;
  challenge?: string;
}
export type WebhookPost = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<PostResult>;
export class EventError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}
const invalid = (message: string): never => {
  throw new EventError(-32602, message);
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonical((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}
export function signingKey(secret: unknown): Buffer {
  if (
    typeof secret !== "string" ||
    !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)
  )
    return invalid("Invalid webhook signing secret");
  const key = Buffer.from(secret.slice(6), "base64");
  if (
    key.length < 24 ||
    key.length > 64 ||
    key.toString("base64").replace(/=+$/, "") !==
      secret.slice(6).replace(/=+$/, "")
  )
    return invalid("Invalid webhook signing secret");
  return key;
}
export function callbackUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\]/.test(value))
    return invalid("Invalid callback URL");
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return invalid("Invalid callback URL");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.hash ||
    (u.port && u.port !== "443")
  )
    return invalid(
      "Callback must use HTTPS on port 443 without credentials or fragments",
    );
  return u.href;
}
export function signedHeaders(
  s: Subscription,
  id: string,
  body: string,
  now = Date.now(),
): Record<string, string> {
  if (Buffer.byteLength(body, "utf8") > 262144)
    return invalid("Event exceeds 256 KiB");
  const timestamp = String(Math.floor(now / 1000));
  const sign = (secret: string) =>
    "v1," +
    createHmac("sha256", signingKey(secret))
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64");
  const signatures = [sign(s.secret)];
  if (s.oldSecret && (s.rotateUntil ?? 0) > now)
    signatures.push(sign(s.oldSecret));
  return {
    "Content-Type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": signatures.join(" "),
    "X-MCP-Subscription-Id": s.id,
  };
}
function equal(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
/** Storage and callback transport are deliberately mandatory; no memory-only production fallback. */
export class EventHub {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly catalog: EventDefinition[],
    readonly store: EventStore,
    readonly post: WebhookPost,
    readonly authorized: (s: Subscription) => Promise<boolean>,
    readonly now = Date.now,
  ) {}
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const task = this.queue.then(run, run);
    this.queue = task.catch(() => {});
    return task;
  }
  private parse(params: Record<string, unknown>, owner: string) {
    if (!owner)
      throw new EventError(-32001, "Authenticated principal required");
    const definition = this.catalog.find((d) => d.name === params.name);
    if (!definition) return invalid("Unknown event");
    const args = params.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args))
      return invalid("Invalid event arguments");
    for (const [key, value] of Object.entries(args))
      if (
        !Object.hasOwn(definition.inputSchema.properties, key) ||
        typeof value !== "string" ||
        !value ||
        value.length > 256
      )
        return invalid("Invalid event filter");
    for (const key of definition.inputSchema.required ?? [])
      if (!Object.hasOwn(args, key)) return invalid("Missing event filter");
    const delivery = params.delivery as Record<string, unknown>;
    if (!delivery || delivery.mode !== "webhook")
      return invalid("Only webhook delivery is supported");
    const url = callbackUrl(delivery.url),
      arguments_ = args as Record<string, string>;
    const id =
      "sub_" +
      hash(canonical({ owner, name: params.name, arguments: arguments_, url }));
    return { definition, args: arguments_, delivery, url, id };
  }
  async handle(
    method: string,
    params: Record<string, unknown>,
    owner: string,
  ): Promise<unknown> {
    if (method === "events/list") {
      if (params.cursor !== undefined && params.cursor !== null)
        return invalid("Invalid event catalog cursor");
      return { events: this.catalog };
    }
    if (method !== "events/subscribe" && method !== "events/unsubscribe")
      throw new EventError(-32601, "Unknown event method");
    return this.serial(async () => {
      const p = this.parse(params, owner);
      if (method === "events/unsubscribe") {
        await this.store.deleteSubscription(p.id);
        return {};
      }
      signingKey(p.delivery.secret);
      if (params.cursor !== undefined && params.cursor !== null)
        return invalid("This event does not support historical replay");
      if (
        params.ttlMs !== undefined &&
        params.ttlMs !== null &&
        (typeof params.ttlMs !== "number" ||
          !Number.isSafeInteger(params.ttlMs) ||
          params.ttlMs <= 0)
      )
        return invalid("Invalid ttlMs");
      const now = this.now(),
        ttl = Math.min(
          typeof params.ttlMs === "number" ? params.ttlMs : 86400000,
          86400000,
        );
      const active = (await this.store.subscriptions()).filter(
        (s) => s.expires > now,
      );
      const previous = active.find((s) => s.id === p.id);
      if (!previous && active.length >= 128)
        throw new EventError(-32000, "Event subscription limit reached");
      const s: Subscription = {
        id: p.id,
        owner,
        name: p.definition.name,
        arguments: p.args,
        url: p.url,
        since: previous?.since ?? now,
        secret: String(p.delivery.secret),
        expires: now + ttl,
        verifiedUntil: now + 300000,
        generation:
          previous?.generation ?? Buffer.from(randomBytes(16)).toString("hex"),
      };
      if (!(await this.authorized(s)))
        throw new EventError(-32001, "Event resource access denied");
      if (previous && previous.secret !== s.secret) {
        s.oldSecret = previous.secret;
        s.rotateUntil = now + 300000;
      } else if (previous?.oldSecret && (previous.rotateUntil ?? 0) > now) {
        s.oldSecret = previous.oldSecret;
        s.rotateUntil = previous.rotateUntil;
      }
      // A changed key must always prove the callback; cached verification is principal + URL + key scoped.
      if (
        !previous ||
        previous.secret !== s.secret ||
        previous.verifiedUntil <= now
      ) {
        const challenge = Buffer.from(randomBytes(32)).toString("base64url"),
          body = JSON.stringify({ type: "verification", challenge });
        const id =
          "msg_verification_" + Buffer.from(randomBytes(16)).toString("hex");
        let response: PostResult;
        try {
          response = await this.post(
            s.url,
            signedHeaders(s, id, body, now),
            body,
          );
        } catch {
          throw new EventError(
            -32015,
            "Callback verification failed",
            "timeout_or_connection_failed",
          );
        }
        if (
          this.now() - now > 10000 ||
          response.status < 200 ||
          response.status >= 300 ||
          typeof response.challenge !== "string" ||
          !equal(challenge, response.challenge)
        )
          throw new EventError(
            -32015,
            "Callback verification failed",
            "challenge_failed",
          );
      } else s.verifiedUntil = previous.verifiedUntil;
      await this.store.putSubscription(s);
      return {
        id: s.id,
        refreshBefore: new Date(s.expires).toISOString(),
        cursor: null,
        truncated: false,
      };
    });
  }
  async emit(
    name: string,
    data: Record<string, unknown>,
    eventId: string,
    timestamp: string,
  ): Promise<void> {
    const definition = this.catalog.find((d) => d.name === name);
    if (!definition) return invalid("Unknown event");
    const schema = definition.payloadSchema as {
      properties?: Record<string, { type?: string }>;
      required?: string[];
      additionalProperties?: boolean;
    };
    for (const key of schema.required ?? [])
      if (!(key in data)) return invalid("Missing event payload field");
    for (const [key, value] of Object.entries(data)) {
      const expected = schema.properties?.[key];
      if (!expected && schema.additionalProperties === false)
        return invalid("Unknown event payload field");
      if (expected?.type && typeof value !== expected.type)
        return invalid("Invalid event payload field");
    }
    if (
      !eventId ||
      eventId.length > 200 ||
      !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(timestamp) ||
      !Number.isFinite(Date.parse(timestamp))
    )
      return invalid("Invalid event identity or timestamp");
    const event: EventRecord = { eventId, name, timestamp, data, cursor: null };
    if (Buffer.byteLength(JSON.stringify(event)) > 262144)
      return invalid("Event exceeds 256 KiB");
    await this.serial(async () => {
      const now = this.now();
      const pending = await this.store.deliveries();
      for (const s of await this.store.subscriptions()) {
        if (
          (s.since !== undefined && Date.parse(timestamp) < s.since) ||
          s.name !== name ||
          s.expires <= now ||
          !Object.entries(s.arguments).every(([k, v]) => data[k] === v)
        )
          continue;
        if (!(await this.authorized(s))) {
          await this.store.deleteSubscription(s.id);
          continue;
        }
        const id = hash(s.id + ":" + s.generation + ":" + eventId);
        // Duplicate source observations must not reset delivery retry state.
        if (pending.some((d) => d.id === id)) continue;
        if (pending.length >= 1000)
          throw new EventError(-32000, "Event delivery backlog limit reached");
        pending.push({
          id,
          subscription: s.id,
          generation: s.generation,
          event,
          attempts: 0,
          due: now,
        });
        await this.store.putDelivery({
          id,
          subscription: s.id,
          generation: s.generation,
          event,
          attempts: 0,
          due: now,
        });
      }
    });
  }
  async flush(): Promise<void> {
    await this.serial(async () => {
      const subs = await this.store.subscriptions();
      for (const s of subs)
        if (s.expires <= this.now()) await this.store.deleteSubscription(s.id);
      for (const d of (await this.store.deliveries())
        .filter((d) => d.due <= this.now())
        .slice(0, 20)) {
        const s = subs.find(
          (s) => s.id === d.subscription && s.generation === d.generation,
        );
        if (!s || s.expires <= this.now() || !(await this.authorized(s))) {
          await this.store.deleteDelivery(d.id);
          continue;
        }
        const body = JSON.stringify(d.event);
        let status = 0;
        try {
          status = (
            await this.post(
              s.url,
              signedHeaders(s, d.event.eventId, body, this.now()),
              body,
            )
          ).status;
        } catch {
          /* bounded transient retry */
        }
        if (status === 410) await this.store.deleteSubscription(s.id);
        if (
          (status >= 200 && status < 300) ||
          status === 410 ||
          status === 413 ||
          (status >= 400 && status < 500 && status !== 429) ||
          d.attempts >= 7
        )
          await this.store.deleteDelivery(d.id);
        else
          await this.store.putDelivery({
            ...d,
            attempts: d.attempts + 1,
            due: this.now() + Math.min(3600000, 1000 * 2 ** d.attempts),
          });
      }
    });
  }
}
