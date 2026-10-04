import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  skillCatalog,
  privateResult,
  traceMeta,
  forwardMeta,
} from "../../src/workflows/core";
import { workflowSkills } from "../../src/workflows/skills";
describe("workflow foundation", () => {
  it("serves complete bounded manifests with exact UTF-8 digests", () => {
    for (const entry of workflowSkills.list().skills) {
      expect(workflowSkills.get(entry.uri).skill).toEqual(entry);
      const result = workflowSkills.read(entry.uri);
      expect(result.contents).toHaveLength(1);
      expect(entry.resources[0]!.digest).toBe(
        "sha256:" +
          createHash("sha256").update(result.contents[0]!.text).digest("hex"),
      );
      expect(result.contents[0]!.text).toContain(
        "name: " + entry.frontmatter.name,
      );
    }
    expect(() => workflowSkills.read("skill://../etc/passwd")).toThrow();
    expect(() => workflowSkills.list("unknown")).toThrow();
    expect(() =>
      skillCatalog("test", [
        { name: "../bad", description: "bad", body: "bad" },
      ]),
    ).toThrow();
  });
  it("keeps caching private and excludes baggage without dropping application metadata", () => {
    expect(privateResult({ text: "private" })).toMatchObject({
      cacheScope: "private",
      ttlMs: 0,
    });
    expect(() => privateResult({}, NaN)).toThrow();
    const traceparent =
      "00-12345678901234567890123456789012-1234567890123456-01";
    expect(
      traceMeta({
        traceparent,
        baggage: "token=secret",
        tracestate: "vendor=secret",
      }),
    ).toEqual({ traceparent });
    expect(
      forwardMeta(
        { ui: { state: "retained" }, baggage: "secret" },
        { traceparent },
      ),
    ).toEqual({ ui: { state: "retained" }, traceparent });
    for (const value of [
      "00-" + "0".repeat(32) + "-1234567890123456-01",
      "secret",
      "00-12345678901234567890123456789012-0000000000000000-01",
    ])
      expect(traceMeta({ traceparent: value })).toEqual({});
  });
});
