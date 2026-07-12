// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/settings/profile/route";
import { userProfilePath } from "@/lib/userProfile";

const ORIGIN = "http://127.0.0.1:3000";

function request(init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", "127.0.0.1:3000");
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !headers.has("origin")) {
    headers.set("origin", ORIGIN);
  }
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Request(`${ORIGIN}/api/settings/profile`, { ...init, headers });
}

const VALID_PROFILE = {
  schemaVersion: 1,
  displayName: "Dylan",
  aliases: ["딜런"],
  timezone: "UTC",
  weekStartsOn: "monday",
};

let originalCwd: string;
let workDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "profile-route-"));
  process.chdir(workDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

describe("/api/settings/profile", () => {
  it("runs the local guard before reading the body or resolving a filesystem path", async () => {
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("filesystem path must not be resolved");
    });
    const getResponse = await GET(new Request("http://evil.test/api/settings/profile", {
      headers: { host: "evil.test" },
    }));
    expect(getResponse.status).toBe(403);
    expect(cwd).not.toHaveBeenCalled();
    cwd.mockRestore();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(VALID_PROFILE)));
        controller.close();
      },
    });
    const deniedRequest = new Request("http://evil.test/api/settings/profile", {
      method: "POST",
      headers: { host: "evil.test", "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const getReader = vi.spyOn(deniedRequest.body as ReadableStream<Uint8Array>, "getReader");
    const postResponse = await POST(deniedRequest);
    expect(postResponse.status).toBe(403);
    expect(getReader).not.toHaveBeenCalled();
    expect(existsSync(join(workDir, "data"))).toBe(false);
  });

  it("GET returns a no-store optional state when the profile is missing", async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      configured: false,
      defaults: { weekStartsOn: "monday" },
    });
    expect(typeof body.defaults.timezone).toBe("string");
    expect(body.defaults.timezone.length).toBeGreaterThan(0);
    expect(existsSync(userProfilePath())).toBe(false);
  });

  it("GET returns a normalized configured profile", async () => {
    await mkdir(dirname(userProfilePath()), { recursive: true });
    await writeFile(userProfilePath(), JSON.stringify({
      ...VALID_PROFILE,
      displayName: " Dylan ",
      aliases: [" 딜런 ", "", "딜런"],
    }));

    const response = await GET(request());
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      configured: true,
      profile: VALID_PROFILE,
    });
  });

  it.each([
    ["text/plain", JSON.stringify(VALID_PROFILE), 415],
    ["application/json", "{", 400],
    ["application/json", JSON.stringify({ ...VALID_PROFILE, extra: true }), 400],
  ])("POST rejects content type/body/schema violations", async (contentType, body, status) => {
    const response = await POST(request({
      method: "POST",
      headers: { "content-type": contentType },
      body,
    }));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(existsSync(userProfilePath())).toBe(false);
  });

  it("POST rejects a body larger than 32 KiB before reading it", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    const oversized = request({
      method: "POST",
      headers: { "content-length": String(32 * 1024 + 1) },
      body,
      duplex: "half",
    } as RequestInit);
    const getReader = vi.spyOn(oversized.body as ReadableStream<Uint8Array>, "getReader");

    const response = await POST(oversized);
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getReader).not.toHaveBeenCalled();
  });

  it("POST atomically stores a normalized profile and returns commit durability", async () => {
    const response = await POST(request({
      method: "POST",
      body: JSON.stringify({
        ...VALID_PROFILE,
        displayName: " Dylan ",
        aliases: [" 딜런 ", "", "딜런"],
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      configured: true,
      profile: VALID_PROFILE,
      durability: expect.stringMatching(/^(?:durable|best_effort|pending)$/u),
    });
    expect(JSON.parse(await readFile(userProfilePath(), "utf8"))).toEqual(VALID_PROFILE);
  });
});
