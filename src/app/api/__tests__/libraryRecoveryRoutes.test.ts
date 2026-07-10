// @vitest-environment node
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as getLibrary } from "@/app/api/library/route";
import { POST as rebuildLibrary } from "@/app/api/library/rebuild/route";
import { GET as getOrganizationPending } from "@/app/api/organization-pending/route";
import { POST as createWorkspace } from "@/app/api/workspaces/route";
import type { StatusJson } from "@/domain/meeting";
import { resetLibraryRepositoryStateForTests } from "@/lib/library";
import { resetMeetingLifecycleForTests } from "@/lib/meetingLifecycle";
import { resetOrganizationPendingStateForTests } from "@/lib/organizationPending";
import { dataRoot, libraryPath, meetingPaths } from "@/lib/paths";
import { readStatus, initialStatus, writeStatus } from "@/lib/status";
import { resetStatusUpdaterStateForTests } from "@/lib/statusUpdater";

const ORIGIN = "http://127.0.0.1:3000";
const OLD_LIBRARY_ID = "70000000-0000-4000-8000-000000000007";
const OLD_BYTES = `${JSON.stringify({
  schemaVersion: 1,
  libraryId: OLD_LIBRARY_ID,
  revision: 0,
  defaultWorkspaceId: "71000000-0000-4000-8000-000000000007",
  workspaces: [],
  folders: [],
  placements: [],
})}\n`;
let workDir: string;
let originalCwd: string;

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", "127.0.0.1:3000");
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !headers.has("origin")) headers.set("origin", ORIGIN);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

async function seedMeeting(id: string, over: Partial<StatusJson> = {}) {
  await writeStatus(id, {
    ...initialStatus(id, {
      startedAt: "2026-07-10T00:00:00.000Z",
      endedAt: "2026-07-10T00:01:00.000Z",
      durationMs: 60_000,
      audioMime: "audio/webm",
    }),
    ...over,
  });
  writeFileSync(meetingPaths(id).audio, `audio-${id}`);
}

function seedCorruptLibrary(bytes = OLD_BYTES): string {
  mkdirSync(dataRoot(), { recursive: true, mode: 0o700 });
  writeFileSync(libraryPath(), bytes, { mode: 0o600 });
  return createHash("sha256").update(bytes).digest("hex");
}

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "library-recovery-route-"));
  process.chdir(workDir);
  resetLibraryRepositoryStateForTests();
  resetMeetingLifecycleForTests();
  resetStatusUpdaterStateForTests();
  resetOrganizationPendingStateForTests();
});

afterEach(() => {
  process.chdir(originalCwd);
  resetLibraryRepositoryStateForTests();
  resetMeetingLifecycleForTests();
  resetStatusUpdaterStateForTests();
  resetOrganizationPendingStateForTests();
  rmSync(workDir, { recursive: true, force: true });
});

describe("corrupt-only library rebuild route", () => {
  it("exposes an opaque corrupt fingerprint and rejects stale/extra/path-bearing input without mutation", async () => {
    const fingerprint = seedCorruptLibrary();
    const state = await (await getLibrary(request("/api/library"))).json();
    expect(state).toMatchObject({
      mode: "degraded_fallback",
      degradedReason: "corrupt",
      recovery: { canRebuild: true, fingerprint },
    });
    const before = readFileSync(libraryPath(), "utf8");
    const stale = await rebuildLibrary(request("/api/library/rebuild", {
      method: "POST",
      body: JSON.stringify({ expectedMode: "corrupt", recoveryFingerprint: "f".repeat(64) }),
    }));
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: { code: "fingerprint_changed" } });

    const injectedPath = await rebuildLibrary(request("/api/library/rebuild", {
      method: "POST",
      body: JSON.stringify({
        expectedMode: "corrupt",
        recoveryFingerprint: fingerprint,
        archivePath: "/tmp/escape",
      }),
    }));
    expect(injectedPath.status).toBe(400);
    expect(readFileSync(libraryPath(), "utf8")).toBe(before);
    expect(readdirSync(dataRoot())).toEqual(["library.json"]);
  });

  it("enforces exact local Origin before any recovery side effect", async () => {
    const fingerprint = seedCorruptLibrary();
    const denied = await rebuildLibrary(request("/api/library/rebuild", {
      method: "POST",
      headers: { origin: "http://evil.example" },
      body: JSON.stringify({ expectedMode: "corrupt", recoveryFingerprint: fingerprint }),
    }));
    expect(denied.status).toBe(403);
    expect(readdirSync(dataRoot())).toEqual(["library.json"]);
    expect(readFileSync(libraryPath(), "utf8")).toBe(OLD_BYTES);
  });

  it("rebuilds revision 0 from every live meeting, archives original bytes privately, and repairs pending placement", async () => {
    await seedMeeting("visible");
    await seedMeeting("pending", {
      placementResolution: { state: "unavailable", receiptHash: "a".repeat(64) },
    });
    const fingerprint = seedCorruptLibrary();
    const response = await rebuildLibrary(request("/api/library/rebuild", {
      method: "POST",
      body: JSON.stringify({ expectedMode: "corrupt", recoveryFingerprint: fingerprint }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      mode: "ready",
      version: { revision: 0 },
      result: {
        discoveredVisibleMeetingCount: 2,
        organizationReset: true,
        archivePreserved: true,
      },
    });
    expect(body.version.libraryId).not.toBe(OLD_LIBRARY_ID);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/library\.archive|library-recovery|\/tmp|OLD_BYTES|visible|pending/);

    const canonical = JSON.parse(readFileSync(libraryPath(), "utf8"));
    expect(canonical.placements).toHaveLength(2);
    expect(new Set(canonical.placements.map((placement: { meetingId: string }) => placement.meetingId)))
      .toEqual(new Set(["visible", "pending"]));
    const recoveryDir = join(dataRoot(), "library-recovery");
    const archives = readdirSync(recoveryDir).filter((name) => name.startsWith("library.archive-"));
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(recoveryDir, archives[0]), "utf8")).toBe(OLD_BYTES);
    if (process.platform !== "win32") {
      expect(statSync(recoveryDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(recoveryDir, archives[0])).mode & 0o777).toBe(0o600);
    }
    expect((await readStatus("pending"))?.placementResolution).toMatchObject({
      state: "resolved",
      resolvedBy: "rebuild",
      resolvedLibraryId: body.version.libraryId,
    });
    const pending = await (await getOrganizationPending(request("/api/organization-pending"))).json();
    expect(pending).toMatchObject({ count: 0, rows: [] });

    const oldGeneration = await createWorkspace(request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({
        expectedLibraryId: OLD_LIBRARY_ID,
        expectedRevision: 0,
        name: "stale",
      }),
    }));
    expect(oldGeneration.status).toBe(409);
  });

  it("refuses ready, missing, and unsupported registries without creating recovery artifacts", async () => {
    mkdirSync(dataRoot(), { recursive: true });
    const missing = await rebuildLibrary(request("/api/library/rebuild", {
      method: "POST",
      body: JSON.stringify({ expectedMode: "corrupt", recoveryFingerprint: "a".repeat(64) }),
    }));
    expect(missing.status).toBe(409);
    expect(readdirSync(dataRoot())).toEqual([]);

    writeFileSync(libraryPath(), JSON.stringify({ schemaVersion: 999 }));
    const unsupported = await rebuildLibrary(request("/api/library/rebuild", {
      method: "POST",
      body: JSON.stringify({
        expectedMode: "corrupt",
        recoveryFingerprint: createHash("sha256").update(JSON.stringify({ schemaVersion: 999 })).digest("hex"),
      }),
    }));
    expect(unsupported.status).toBe(409);
    expect(readdirSync(dataRoot())).toEqual(["library.json"]);
  });

  it("surfaces an ambiguous active recovery as conflict without offering rebuild", async () => {
    seedCorruptLibrary();
    const recoveryDir = join(dataRoot(), "library-recovery");
    mkdirSync(recoveryDir, { mode: 0o700 });
    writeFileSync(
      join(recoveryDir, ".library-recovery-10000000-0000-4000-8000-000000000001.intent.json"),
      "{ invalid intent\n",
      { mode: 0o600 },
    );
    const response = await getLibrary(request("/api/library"));
    const body = await response.json();
    expect(body).toMatchObject({
      mode: "degraded_fallback",
      degradedReason: "recovery_conflict",
      version: null,
    });
    expect(body.recovery).toBeUndefined();
    expect(readFileSync(libraryPath(), "utf8")).toBe(OLD_BYTES);
  });
});
