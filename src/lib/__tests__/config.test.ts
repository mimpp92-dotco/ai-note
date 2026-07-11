import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  localSttBaseUrl,
  localSttHost,
  localSttLang,
  localSttPort,
} from "@/lib/config";

const KEYS = ["LOCAL_STT_HOST", "LOCAL_STT_PORT", "LOCAL_STT_LANG"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("config defaults", () => {
  it("defaults the whisper address to the contract host/port", () => {
    expect(localSttHost()).toBe("127.0.0.1");
    expect(localSttPort()).toBe(8123);
    expect(localSttBaseUrl()).toBe("http://127.0.0.1:8123");
  });

  it("defaults the whisper decode language to Korean", () => {
    expect(localSttLang()).toBe("ko");
  });

  it("honors env overrides read lazily", () => {
    process.env.LOCAL_STT_HOST = "127.0.0.1";
    process.env.LOCAL_STT_PORT = "9999";
    process.env.LOCAL_STT_LANG = "en";
    expect(localSttPort()).toBe(9999);
    expect(localSttBaseUrl()).toBe("http://127.0.0.1:9999");
    expect(localSttLang()).toBe("en");
  });

  it("fails closed on non-loopback or invalid service destinations", () => {
    process.env.LOCAL_STT_HOST = "evil.test";
    expect(() => localSttBaseUrl()).toThrowError("unsafe_local_endpoint");
    process.env.LOCAL_STT_HOST = "127.0.0.1";
    process.env.LOCAL_STT_PORT = "8123junk";
    expect(() => localSttBaseUrl()).toThrowError("unsafe_local_endpoint");
    process.env.LOCAL_STT_PORT = "0";
    expect(() => localSttBaseUrl()).toThrowError("unsafe_local_endpoint");
  });
});
