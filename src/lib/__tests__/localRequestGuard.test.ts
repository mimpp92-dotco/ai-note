// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  DATA_SURFACE_INVENTORY,
  guardLocalApiRequest,
  parseBoundedJsonBody,
  validateLocalRequest,
} from "@/lib/localRequestGuard";

const BASE = "http://127.0.0.1:3000";

function request(
  path = "/api/meetings",
  init: RequestInit = {},
): Request {
  return new Request(`${BASE}${path}`, {
    ...init,
    headers: {
      host: "127.0.0.1:3000",
      ...(init.headers ?? {}),
    },
  });
}

describe("local request boundary", () => {
  it.each([
    "127.0.0.1",
    "127.0.0.1:3000",
    "localhost",
    "localhost:65535",
  ])("accepts exact loopback Host %s", (host) => {
    const req = new Request(`http://${host}/api/meetings`, { headers: { host } });
    expect(validateLocalRequest(req, "api")).toEqual({ ok: true });
  });

  it.each([
    "localhost.evil",
    "localhost.",
    "user@localhost:3000",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.0.0.1:not-a-port",
    "localhost:03000",
    "localhost, 127.0.0.1",
    "[::1]:3000",
  ])("rejects ambiguous/non-contract Host %s", (host) => {
    const req = new Request(BASE, { headers: { host } });
    expect(validateLocalRequest(req, "api")).toMatchObject({ ok: false, code: "invalid_host" });
  });

  it("rejects a URL authority that disagrees with Host", () => {
    const req = new Request("http://localhost:3000/api/meetings", {
      headers: { host: "127.0.0.1:3000" },
    });
    expect(validateLocalRequest(req, "api")).toMatchObject({ ok: false, code: "invalid_host" });
  });

  it.each(["cross-site", "same-site", "none"])("rejects API Sec-Fetch-Site %s", (site) => {
    expect(validateLocalRequest(request("/api/meetings", {
      headers: { "sec-fetch-site": site },
    }), "api")).toMatchObject({ ok: false, code: "cross_site_request" });
  });

  it("allows same-origin API/RSC and direct document navigation only for pages", () => {
    expect(validateLocalRequest(request("/api/meetings", {
      headers: { "sec-fetch-site": "same-origin" },
    }), "api")).toEqual({ ok: true });
    expect(validateLocalRequest(request("/meetings/m1", {
      headers: { "sec-fetch-site": "none" },
    }), "page")).toEqual({ ok: true });
    expect(validateLocalRequest(request("/meetings/m1", {
      headers: { "sec-fetch-site": "same-origin", rsc: "1" },
    }), "page")).toEqual({ ok: true });
  });

  it.each([
    [null, "missing_origin"],
    ["null", "invalid_origin"],
    ["http://localhost:3000", "invalid_origin"],
    ["https://127.0.0.1:3000", "invalid_origin"],
    ["http://127.0.0.1:3001", "invalid_origin"],
  ] as const)("rejects unsafe request Origin %s", (origin, code) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (origin !== null) headers.origin = origin;
    const req = request("/api/settings/llm", {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(validateLocalRequest(req, "api")).toMatchObject({ ok: false, code });
  });

  it("accepts an exact unsafe-method Origin", () => {
    const req = request("/api/settings/llm", {
      method: "POST",
      headers: {
        origin: BASE,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: "{}",
    });
    expect(validateLocalRequest(req, "api")).toEqual({ ok: true });
  });

  it("returns a no-store static error envelope", async () => {
    const response = guardLocalApiRequest(new Request("http://evil.test/api/meetings", {
      headers: { host: "evil.test" },
    }));
    expect(response?.status).toBe(403);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toEqual({
      error: {
        code: "invalid_host",
        message: "로컬 앱 요청만 허용됩니다",
      },
    });
  });
});

describe("bounded JSON stream", () => {
  function jsonRequest(body: BodyInit, headers: Record<string, string> = {}) {
    return request("/api/test", {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json; charset=utf-8", ...headers },
      body,
      duplex: "half",
    } as RequestInit);
  }

  it("parses JSON with optional UTF-8 charset", async () => {
    await expect(parseBoundedJsonBody(jsonRequest(JSON.stringify({ 이름: "딜런" })), 1024))
      .resolves.toEqual({ 이름: "딜런" });
  });

  it.each(["text/plain", "application/json-patch+json", "application/json; charset=euc-kr"])(
    "rejects content type %s",
    async (contentType) => {
      await expect(parseBoundedJsonBody(jsonRequest("{}", { "content-type": contentType }), 1024))
        .rejects.toMatchObject({ code: "unsupported_media_type", status: 415 });
    },
  );

  it("rejects an oversized declared body before reading", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    const req = jsonRequest(body, { "content-length": "9999" });
    const getReader = vi.spyOn(req.body as ReadableStream<Uint8Array>, "getReader");
    await expect(parseBoundedJsonBody(req, 16)).rejects.toMatchObject({
      code: "request_body_too_large",
      status: 413,
    });
    expect(getReader).not.toHaveBeenCalled();
  });

  it("counts raw UTF-8 bytes and caps chunked bodies", async () => {
    const chunks = ["{\"x\":\"", "한글한글", "\"}"];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    await expect(parseBoundedJsonBody(jsonRequest(stream), 12)).rejects.toMatchObject({
      code: "request_body_too_large",
    });
  });

  it("rejects malformed JSON and invalid Content-Length", async () => {
    await expect(parseBoundedJsonBody(jsonRequest("{"), 1024)).rejects.toMatchObject({
      code: "invalid_json",
    });
    await expect(parseBoundedJsonBody(jsonRequest("{}", { "content-length": "2x" }), 1024))
      .rejects.toMatchObject({ code: "invalid_content_length" });
  });
});

describe("data-surface inventory", () => {
  it("contains every current API and data-reading RSC boundary", () => {
    expect(DATA_SURFACE_INVENTORY).toEqual(expect.arrayContaining([
      "/api/chat",
      "/api/meetings",
      "/api/meetings/[id]",
      "/api/meetings/[id]/audio",
      "/api/meetings/[id]/content",
      "/api/meetings/[id]/export",
      "/api/meetings/[id]/finalize",
      "/api/meetings/[id]/reveal",
      "/api/meetings/[id]/review",
      "/api/meetings/[id]/summarize",
      "/api/meetings/[id]/summary",
      "/api/meetings/[id]/title",
      "/api/meetings/[id]/transcript",
      "/api/meetings/[id]/transcript/regenerate",
      "/api/knowledge/reindex",
      "/api/search",
      "/api/transcribe",
      "/api/glossary",
      "/api/settings/llm",
      "/api/settings/llm/health",
      "/api/settings/pipeline",
      "/api/settings/profile",
      "/api/whisper/health",
      "/api/whisper/models/prepare",
      "/meetings/[id]",
    ]));
    expect(new Set(DATA_SURFACE_INVENTORY).size).toBe(DATA_SURFACE_INVENTORY.length);
  });

  it("matches every route.ts on disk and requires the guard before request work", () => {
    const apiRoot = join(process.cwd(), "src", "app", "api");
    const routeFiles = (readdirSync(apiRoot, { recursive: true, encoding: "utf8" }) as string[])
      .filter((file) => file.endsWith("route.ts"))
      .sort();
    const routeInventory = DATA_SURFACE_INVENTORY.filter((path) => path.startsWith("/api/"))
      .map((path) => `${path.slice("/api/".length)}/route.ts`)
      .sort();
    expect(routeInventory).toEqual(routeFiles);
    for (const relativePath of routeFiles) {
      const source = readFileSync(join(apiRoot, relativePath), "utf8");
      const guardIndex = source.indexOf("guardLocalApiRequest(request)");
      expect(guardIndex, relativePath).toBeGreaterThan(-1);
      const paramsIndex = source.indexOf("await params");
      if (paramsIndex >= 0) expect(guardIndex, relativePath).toBeLessThan(paramsIndex);
    }
  });
});
