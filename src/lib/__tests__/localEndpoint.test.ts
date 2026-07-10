import { afterEach, describe, expect, it } from "vitest";

import {
  normalizeLoopbackHttpBaseUrl,
  validateLoopbackHostAndPort,
} from "@/lib/localEndpoint";

describe("loopback egress destination", () => {
  it.each([
    ["http://127.0.0.1:11434", "http://127.0.0.1:11434"],
    ["http://localhost:11434/", "http://localhost:11434"],
    ["  http://localhost:8123  ", "http://localhost:8123"],
  ])("accepts and canonicalizes %s", (input, expected) => {
    expect(normalizeLoopbackHttpBaseUrl(input)).toBe(expected);
  });

  it.each([
    "https://localhost:11434",
    "http://0.0.0.0:11434",
    "http://127.0.0.2:11434",
    "http://[::1]:11434",
    "http://user:pass@localhost:11434",
    "http://localhost",
    "http://localhost:0",
    "http://localhost:65536",
    "http://localhost:11434/api",
    "http://localhost:11434?x=1",
    "http://localhost:11434#fragment",
    "http://localhost.:11434",
  ])("rejects %s", (input) => {
    expect(() => normalizeLoopbackHttpBaseUrl(input)).toThrowError("unsafe_local_endpoint");
  });

  it("validates split Whisper host/port values", () => {
    expect(validateLoopbackHostAndPort("127.0.0.1", 8123)).toEqual({
      host: "127.0.0.1",
      port: 8123,
      baseUrl: "http://127.0.0.1:8123",
    });
    expect(validateLoopbackHostAndPort("localhost", 3000).baseUrl).toBe("http://localhost:3000");
    expect(() => validateLoopbackHostAndPort("evil.test", 8123)).toThrowError("unsafe_local_endpoint");
  });
});

afterEach(() => {
  delete process.env.LOCAL_STT_HOST;
  delete process.env.LOCAL_STT_PORT;
});
