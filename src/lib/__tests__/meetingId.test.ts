import { describe, expect, it } from "vitest";

import { assertSafeId, isSafeId } from "@/lib/meetingId";

describe("assertSafeId", () => {
  it("accepts UUIDs and safe slugs", () => {
    expect(assertSafeId("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(assertSafeId("meeting-2026-07-05")).toBe("meeting-2026-07-05");
    expect(assertSafeId("abc_123")).toBe("abc_123");
  });

  it("rejects path traversal and absolute paths", () => {
    for (const bad of [
      "..",
      "../etc/passwd",
      "foo/../bar",
      "/etc/passwd",
      "a/b",
      "a\\b",
      ".hidden",
      "",
      " leading-space",
    ]) {
      expect(() => assertSafeId(bad)).toThrow();
      expect(isSafeId(bad)).toBe(false);
    }
  });

  it("rejects non-string input", () => {
    expect(() => assertSafeId(undefined)).toThrow();
    expect(() => assertSafeId(123)).toThrow();
  });
});
