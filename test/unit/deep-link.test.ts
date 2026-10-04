import { it, expect } from "vitest";
import { appRoute } from "../../src/ui/deep-link";
it("accepts only bounded local course and memory identities", () => {
  expect(appRoute({ url: "/course/123" })).toEqual({
    kind: "course",
    id: "123",
  });
  expect(appRoute({ url: "/memory/abc-123" })).toEqual({
    kind: "memory",
    id: "abc-123",
  });
  for (const url of [
    "https://outside.invalid",
    "//outside.invalid",
    "/memory/../x",
    "/course/0",
    "/memory/x?token=secret",
    "/memory/x#fragment",
    "/memory/a%2Fb",
  ])
    expect(appRoute({ url })).toBeNull();
});
