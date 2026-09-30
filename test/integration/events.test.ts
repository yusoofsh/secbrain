import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  EventHub,
  canonical,
  signedHeaders,
  type EventStore,
  type Subscription,
  type Delivery,
  type EventDefinition,
} from "../../src/events/core.js";
import { publicAddress } from "../../src/events/webhook.js";
const key = "whsec_" + Buffer.alloc(32, 7).toString("base64");
const catalog: EventDefinition[] = [
  {
    name: "record.changed",
    description: "Record changed",
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: {
        resource_id: { type: "string" },
        account_id: { type: "string" },
      },
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: {
        resource_id: { type: "string" },
        account_id: { type: "string" },
      },
      required: ["resource_id"],
      additionalProperties: false,
    },
  },
];
class Store implements EventStore {
  s = new Map<string, Subscription>();
  d = new Map<string, Delivery>();
  async subscriptions() {
    return [...this.s.values()];
  }
  async deliveries() {
    return [...this.d.values()];
  }
  async putSubscription(s: Subscription) {
    this.s.set(s.id, structuredClone(s));
  }
  async putDelivery(d: Delivery) {
    this.d.set(d.id, structuredClone(d));
  }
  async deleteSubscription(id: string) {
    this.s.delete(id);
  }
  async deleteDelivery(id: string) {
    this.d.delete(id);
  }
}
function fixture() {
  const store = new Store();
  let time = Date.parse("2026-09-30T09:00:00Z"),
    allowed = true,
    status = 204;
  const sent: { headers: Record<string, string>; body: string }[] = [];
  const hub = () =>
    new EventHub(
      catalog,
      store,
      async (_url, headers, body) => {
        sent.push({ headers, body });
        const data = JSON.parse(body);
        return data.type === "verification"
          ? { status: 200, challenge: data.challenge }
          : { status };
      },
      async () => allowed,
      () => time,
    );
  return {
    store,
    hub,
    sent,
    advance: (ms: number) => {
      time += ms;
    },
    revoke: () => {
      allowed = false;
    },
    status: (s: number) => {
      status = s;
    },
  };
}
const params = (args: Record<string, string> = {}) => ({
  name: "record.changed",
  arguments: args,
  delivery: {
    mode: "webhook",
    url: "https://callback.example.test/events",
    secret: key,
  },
});
describe("MCP Events wire and security contract", () => {
  it("canonicalizes keys, verifies callback once, persists and refreshes one identity across restart", async () => {
    const f = fixture();
    const a = (await f
      .hub()
      .handle(
        "events/subscribe",
        params({ resource_id: "r", account_id: "a" }),
        "owner",
      )) as any;
    const b = (await f
      .hub()
      .handle(
        "events/subscribe",
        params({ account_id: "a", resource_id: "r" }),
        "owner",
      )) as any;
    expect(a.id).toBe(b.id);
    expect(f.store.s.size).toBe(1);
    expect(f.sent.length).toBe(1);
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    expect(
      ((await f.hub().handle("events/subscribe", params(), "another")) as any)
        .id,
    ).not.toBe(a.id);
  });
  it("filters before delivery and signs exactly the body bytes with Standard Webhooks", async () => {
    const f = fixture(),
      hub = f.hub();
    await hub.handle("events/subscribe", params({ resource_id: "r" }), "owner");
    await hub.emit(
      "record.changed",
      { resource_id: "other" },
      "evt_1",
      "2026-09-30T10:00:00Z",
    );
    await hub.emit(
      "record.changed",
      { resource_id: "r" },
      "evt_2",
      "2026-09-30T10:01:00Z",
    );
    await hub.flush();
    expect(f.sent.length).toBe(2);
    const delivery = f.sent[1],
      h = delivery.headers;
    expect(h["webhook-id"]).toBe("evt_2");
    const signature = createHmac("sha256", Buffer.alloc(32, 7))
      .update(`evt_2.${h["webhook-timestamp"]}.${delivery.body}`)
      .digest("base64");
    expect(h["webhook-signature"]).toBe("v1," + signature);
    expect(f.store.d.size).toBe(0);
  });
  it("keeps an event identity across retries, refreshes signatures and stops 410/413", async () => {
    const f = fixture(),
      hub = f.hub();
    await hub.handle("events/subscribe", params(), "owner");
    await hub.emit(
      "record.changed",
      { resource_id: "r" },
      "evt_3",
      "2026-09-30T10:00:00Z",
    );
    f.status(503);
    await hub.flush();
    expect(f.store.d.size).toBe(1);
    f.advance(2000);
    f.status(410);
    await f.hub().flush();
    expect(f.sent[1].body).toBe(f.sent[2].body);
    expect(f.sent[1].headers["webhook-signature"]).not.toBe(
      f.sent[2].headers["webhook-signature"],
    );
    expect(f.store.d.size).toBe(0);
    expect(f.store.s.size).toBe(0);
    await hub.handle("events/subscribe", params(), "owner");
    await hub.emit(
      "record.changed",
      { resource_id: "r" },
      "evt_4",
      "2026-09-30T10:00:00Z",
    );
    f.status(413);
    await hub.flush();
    expect(f.store.d.size).toBe(0);
  });
  it("rejects unknown filters, weak keys, bad callback verification and non-replay cursors", async () => {
    const f = fixture(),
      hub = f.hub();
    await expect(
      hub.handle("events/subscribe", params({ evil: "x" }), "owner"),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      hub.handle(
        "events/subscribe",
        {
          ...params(),
          delivery: { ...params().delivery, secret: "whsec_YQ==" },
        },
        "owner",
      ),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      hub.handle("events/subscribe", { ...params(), cursor: "old" }, "owner"),
    ).rejects.toMatchObject({ code: -32602 });
    const broken = new EventHub(
      catalog,
      f.store,
      async () => ({ status: 200, challenge: "wrong" }),
      async () => true,
    );
    await expect(
      broken.handle("events/subscribe", params(), "owner"),
    ).rejects.toMatchObject({ code: -32015 });
    expect(f.store.s.size).toBe(0);
  });
  it("honors expiration, ownership, revoked access, unsubscribe and the payload limit", async () => {
    const f = fixture(),
      hub = f.hub();
    await hub.handle("events/subscribe", { ...params(), ttlMs: 1000 }, "owner");
    await hub.handle("events/unsubscribe", params(), "other");
    expect(f.store.s.size).toBe(1);
    await hub.emit(
      "record.changed",
      { resource_id: "r" },
      "evt_5",
      "2026-09-30T10:00:00Z",
    );
    f.advance(1001);
    await hub.flush();
    expect(f.sent.length).toBe(1);
    await hub.handle("events/subscribe", params(), "owner");
    await hub.emit(
      "record.changed",
      { resource_id: "r" },
      "evt_6",
      "2026-09-30T10:00:00Z",
    );
    f.revoke();
    await hub.flush();
    expect(f.sent.length).toBe(2);
    await expect(
      hub.emit(
        "record.changed",
        { resource_id: "x".repeat(262144) },
        "evt_big",
        "2026-09-30T10:00:00Z",
      ),
    ).rejects.toMatchObject({ code: -32602 });
    await hub.handle("events/unsubscribe", params(), "owner");
    await hub.handle("events/unsubscribe", params(), "owner");
    expect(f.store.s.size).toBe(0);
  });
  it("blocks private, local, multicast, documentation, mapped and transitional destinations", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "100.64.1.1",
      "192.0.2.1",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "2002:7f00:1::",
      "2001:db8::1",
    ])
      expect(publicAddress(ip), ip).toBe(false);
    expect(publicAddress("1.1.1.1")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });
});
