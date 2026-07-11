// @vitest-environment node
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as libraryGET } from "@/app/api/library/route";
import { POST as finalizePOST } from "@/app/api/meetings/[id]/finalize/route";
import { GET as locationGET } from "@/app/api/meetings/[id]/location/route";
import { GET as organizationPendingGET } from "@/app/api/organization-pending/route";
import { createFolder } from "@/domain/libraryMutations";
import { resetArtifactLeaseStateForTests } from "@/lib/artifactLease";
import { resetLibraryRepositoryStateForTests } from "@/lib/library";
import { readResolvedLibraryState } from "@/lib/libraryService";
import { resetMeetingCleanupStateForTests } from "@/lib/meetingCleanup";
import { resetMeetingLifecycleForTests } from "@/lib/meetingLifecycle";
import { resetMeetingTombstoneStateForTests } from "@/lib/meetingTombstone";
import { finalizeStagingPaths, libraryPath, meetingPaths } from "@/lib/paths";
import { resetStatusUpdaterStateForTests } from "@/lib/statusUpdater";

const ORIGIN = "http://127.0.0.1:3000";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function baseRequest(path: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: ORIGIN,
      "content-type": "audio/webm",
    },
  });
}

function getRequest(path: string): Request {
  return new Request(`${ORIGIN}${path}`, { headers: { host: "127.0.0.1:3000" } });
}

function requestWithObservedBody(path: string, onRead: () => void): Request {
  const request = baseRequest(path);
  Object.defineProperty(request, "body", {
    get() {
      onRead();
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          controller.close();
        },
      });
    },
  });
  return request;
}

let originalCwd: string;
let workDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "finalize-atomic-"));
  process.chdir(workDir);
  process.env.FAKE_FFMPEG = "1";
  process.env.LOCAL_STT_HOST = "127.0.0.1";
  process.env.LOCAL_STT_PORT = "8123";
  resetArtifactLeaseStateForTests();
  resetLibraryRepositoryStateForTests();
  resetMeetingCleanupStateForTests();
  resetMeetingLifecycleForTests();
  resetMeetingTombstoneStateForTests();
  resetStatusUpdaterStateForTests();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { dispatchId: string };
    return { status: 202, json: async () => ({ dispatchId: body.dispatchId, status: "accepted" }) };
  }));
});

afterEach(() => {
  process.chdir(originalCwd);
  delete process.env.FAKE_FFMPEG;
  delete process.env.LOCAL_STT_HOST;
  delete process.env.LOCAL_STT_PORT;
  resetArtifactLeaseStateForTests();
  resetLibraryRepositoryStateForTests();
  resetMeetingCleanupStateForTests();
  resetMeetingLifecycleForTests();
  resetMeetingTombstoneStateForTests();
  resetStatusUpdaterStateForTests();
  vi.unstubAllGlobals();
  rmSync(workDir, { recursive: true, force: true });
});

describe("atomic finalize and placement", () => {
  it("durably writes intent before reading audio, publishes receipt-only final dir, and snapshots default location", async () => {
    const id = "meeting-finalize-atomic";
    let intentExistedAtBodyRead = false;
    const request = requestWithObservedBody(
      `/api/meetings/${id}/finalize?durationMs=5000&mime=${encodeURIComponent("audio/webm")}&startedAt=${encodeURIComponent("2026-07-10T00:00:00.000Z")}`,
      () => { intentExistedAtBodyRead = existsSync(finalizeStagingPaths(id).intent); },
    );

    const response = await finalizePOST(request, ctx(id));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      artifact: "published",
      playback: "ready",
      placement: { outcome: "saved" },
      transcription: "accepted",
    });
    expect(intentExistedAtBodyRead).toBe(true);
    expect(existsSync(finalizeStagingPaths(id).dir)).toBe(false);
    expect(existsSync(meetingPaths(id).audio)).toBe(true);
    expect(existsSync(meetingPaths(id).status)).toBe(true);
    expect(existsSync(join(meetingPaths(id).dir, ".finalize-receipt.json"))).toBe(true);
    expect(existsSync(join(meetingPaths(id).dir, ".finalize-intent.json"))).toBe(false);

    const state = await readResolvedLibraryState();
    const placement = state.document?.placements.find((item) => item.meetingId === id);
    expect(placement).toEqual({
      meetingId: id,
      workspaceId: state.document?.defaultWorkspaceId,
      folderId: null,
    });
  });

  it("answers an already-published retry without observing the replacement body", async () => {
    const id = "meeting-finalize-retry";
    const path = `/api/meetings/${id}/finalize?durationMs=5000&mime=audio%2Fwebm&startedAt=2026-07-10T00%3A00%3A00.000Z`;
    expect((await finalizePOST(requestWithObservedBody(path, () => {}), ctx(id))).status).toBe(200);
    const retry = baseRequest(path);
    Object.defineProperty(retry, "body", {
      get() {
        throw new Error("published retry must not read body");
      },
    });
    const response = await finalizePOST(retry, ctx(id));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ artifact: "already_published" });

    const probe = baseRequest(`${path}&probe=1`);
    Object.defineProperty(probe, "body", {
      get() {
        throw new Error("published probe must not read body");
      },
    });
    await expect((await finalizePOST(probe, ctx(id))).json()).resolves.toMatchObject({
      probe: "published",
      artifact: "already_published",
    });
  });

  it("classifies an ambiguous probe without creating or consuming recording state", async () => {
    const missingId = "meeting-finalize-probe-missing";
    const missingPath = `/api/meetings/${missingId}/finalize?durationMs=5&mime=audio%2Fwebm&startedAt=2026-07-10T00%3A00%3A00.000Z&probe=1`;
    const missing = baseRequest(missingPath);
    Object.defineProperty(missing, "body", { get: () => { throw new Error("probe body read"); } });
    await expect((await finalizePOST(missing, ctx(missingId))).json()).resolves.toEqual({
      probe: "not_committed",
    });
    expect(existsSync(finalizeStagingPaths(missingId).dir)).toBe(false);

    const stagedId = "meeting-finalize-probe-staged";
    const stagedPath = `/api/meetings/${stagedId}/finalize?durationMs=5&mime=audio%2Fwebm&startedAt=2026-07-10T00%3A00%3A00.000Z`;
    expect((await finalizePOST(baseRequest(stagedPath), ctx(stagedId))).status).toBe(400);
    const bodyRequired = baseRequest(`${stagedPath}&probe=1`);
    Object.defineProperty(bodyRequired, "body", { get: () => { throw new Error("probe body read"); } });
    await expect((await finalizePOST(bodyRequired, ctx(stagedId))).json()).resolves.toMatchObject({
      probe: "body_required",
    });

    await writeFile(finalizeStagingPaths(stagedId).audio, new Uint8Array([7, 8, 9]));
    const resume = baseRequest(`${stagedPath}&probe=1`);
    Object.defineProperty(resume, "body", { get: () => { throw new Error("resume probe body read"); } });
    await expect((await finalizePOST(resume, ctx(stagedId))).json()).resolves.toMatchObject({
      probe: "published",
      artifact: "published",
    });
    expect(existsSync(meetingPaths(stagedId).audio)).toBe(true);
  });

  it("pins the first accepted metadata before body and rejects a conflicting retry without reading it", async () => {
    const id = "meeting-finalize-intent-conflict";
    const originalPath = `/api/meetings/${id}/finalize?durationMs=5&mime=audio%2Fwebm&startedAt=2026-07-10T00%3A00%3A00.000Z`;
    const acceptedWithoutBody = await finalizePOST(baseRequest(originalPath), ctx(id));
    expect(acceptedWithoutBody.status).toBe(400);
    expect(existsSync(finalizeStagingPaths(id).intent)).toBe(true);

    let conflictingBodyObserved = false;
    const conflictPath = originalPath.replace("durationMs=5", "durationMs=6");
    const conflict = await finalizePOST(requestWithObservedBody(conflictPath, () => {
      conflictingBodyObserved = true;
    }), ctx(id));
    expect(conflict.status).toBe(409);
    expect(conflictingBodyObserved).toBe(false);

    const resumed = await finalizePOST(requestWithObservedBody(originalPath, () => {}), ctx(id));
    expect(resumed.status).toBe(200);
    await expect(resumed.json()).resolves.toMatchObject({ artifact: "published" });
  });

  it("retains a durable intent after an aborted stream and resumes with the same attempt", async () => {
    const id = "meeting-finalize-stream-resume";
    const path = `/api/meetings/${id}/finalize?durationMs=5&mime=audio%2Fwebm&startedAt=2026-07-10T00%3A00%3A00.000Z`;
    const interrupted = baseRequest(path);
    Object.defineProperty(interrupted, "body", {
      get() {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.error(new Error("upload interrupted"));
          },
        });
      },
    });
    expect((await finalizePOST(interrupted, ctx(id))).status).toBe(500);
    const intent = JSON.parse(await readFile(finalizeStagingPaths(id).intent, "utf8"));
    expect(existsSync(finalizeStagingPaths(id).audio)).toBe(false);

    const resumed = await finalizePOST(requestWithObservedBody(path, () => {}), ctx(id));
    expect(resumed.status).toBe(200);
    const receipt = JSON.parse(await readFile(
      join(meetingPaths(id).dir, ".finalize-receipt.json"),
      "utf8",
    ));
    expect(receipt.acceptedAt).toBe(intent.acceptedAt);
    expect(receipt.startedAt).toBe(intent.startedAt);
  });

  it("rejects invalid query metadata before observing the audio body", async () => {
    const id = "meeting-finalize-invalid-query";
    let observed = false;
    const request = requestWithObservedBody(
      `/api/meetings/${id}/finalize?durationMs=1&durationMs=2&mime=audio%2Fwebm`,
      () => { observed = true; },
    );
    expect((await finalizePOST(request, ctx(id))).status).toBe(400);
    expect(observed).toBe(false);
    expect(existsSync(finalizeStagingPaths(id).dir)).toBe(false);
  });

  it("persists an explicit folder destination in the same finalize result", async () => {
    const initial = await readResolvedLibraryState();
    const workspaceId = initial.document!.defaultWorkspaceId;
    const folderId = randomUUID();
    await initial.repository.transactLatest((document) => createFolder(document, {
      id: folderId,
      workspaceId,
      parentFolderId: null,
      name: "프로젝트",
      now: "2026-07-10T00:00:00.000Z",
    }));
    const id = "meeting-finalize-folder";
    const path = `/api/meetings/${id}/finalize?durationMs=1&mime=audio%2Fwebm&startedAt=2026-07-10T00%3A00%3A00.000Z&workspaceId=${workspaceId}&folderId=${folderId}`;
    const response = await finalizePOST(requestWithObservedBody(path, () => {}), ctx(id));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      placement: {
        requested: { workspaceId, folderId },
        actual: { workspaceId, folderId },
        outcome: "saved",
      },
    });
    const receipt = JSON.parse(await readFile(join(meetingPaths(id).dir, ".finalize-receipt.json"), "utf8"));
    expect(receipt).toMatchObject({
      requestedLocation: { workspaceId, folderId },
      locationSource: "explicit",
    });
    const location = await locationGET(getRequest(`/api/meetings/${id}/location`), ctx(id));
    expect(location.status).toBe(200);
    await expect(location.json()).resolves.toMatchObject({
      version: { libraryId: initial.version?.libraryId },
      location: { workspaceId, folderId, breadcrumb: ["프로젝트"] },
    });
  });

  it("falls back from a stale folder, then from a stale workspace, without losing requested IDs", async () => {
    const initial = await readResolvedLibraryState();
    const defaultWorkspaceId = initial.document!.defaultWorkspaceId;
    const missingFolderId = randomUUID();
    const folderId = "meeting-finalize-folder-fallback";
    const folderPath = `/api/meetings/${folderId}/finalize?durationMs=1&mime=audio%2Fwebm&startedAt=2026-07-10T00%3A00%3A00.000Z&workspaceId=${defaultWorkspaceId}&folderId=${missingFolderId}`;
    const folderResult = await (await finalizePOST(
      requestWithObservedBody(folderPath, () => {}),
      ctx(folderId),
    )).json();
    expect(folderResult.placement).toEqual({
      requested: { workspaceId: defaultWorkspaceId, folderId: missingFolderId },
      actual: { workspaceId: defaultWorkspaceId, folderId: null },
      outcome: "fallback",
      fallbackReason: "folder_missing",
    });

    const missingWorkspaceId = randomUUID();
    const workspaceMeetingId = "meeting-finalize-workspace-fallback";
    const workspacePath = `/api/meetings/${workspaceMeetingId}/finalize?durationMs=1&mime=audio%2Fwebm&startedAt=2026-07-10T00%3A00%3A00.000Z&workspaceId=${missingWorkspaceId}`;
    const workspaceResult = await (await finalizePOST(
      requestWithObservedBody(workspacePath, () => {}),
      ctx(workspaceMeetingId),
    )).json();
    expect(workspaceResult.placement).toEqual({
      requested: { workspaceId: missingWorkspaceId, folderId: null },
      actual: { workspaceId: defaultWorkspaceId, folderId: null },
      outcome: "fallback",
      fallbackReason: "workspace_missing",
    });
  });

  it("keeps degraded placement discoverable, then resolves it from the receipt without re-reading audio", async () => {
    const initial = await readResolvedLibraryState();
    const workspaceId = initial.document!.defaultWorkspaceId;
    const canonicalLibrary = await readFile(libraryPath());
    await writeFile(libraryPath(), "{");
    const id = "meeting-finalize-pending";
    const path = `/api/meetings/${id}/finalize?durationMs=1&mime=audio%2Fwebm&startedAt=2026-07-10T00%3A00%3A00.000Z&workspaceId=${workspaceId}`;
    const first = await finalizePOST(requestWithObservedBody(path, () => {}), ctx(id));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      version: null,
      placement: { requested: { workspaceId, folderId: null }, outcome: "unavailable" },
    });

    const degradedLibrary = await (await libraryGET(getRequest("/api/library"))).json();
    expect(degradedLibrary.library.counts.organizationPendingCount).toBe(1);
    const pending = await (await organizationPendingGET(
      getRequest("/api/organization-pending?limit=10"),
    )).json();
    expect(pending).toMatchObject({ count: 1 });
    expect(pending.rows[0]).toMatchObject({
      id,
      organizationPending: true,
      requested: { workspaceId, folderId: null },
      actual: null,
    });

    await writeFile(libraryPath(), canonicalLibrary);
    const beforeResolver = await readResolvedLibraryState();
    expect(beforeResolver.document?.placements.some((item) => item.meetingId === id)).toBe(false);
    expect(beforeResolver.library?.counts.organizationPendingCount).toBe(1);
    const retry = baseRequest(path);
    Object.defineProperty(retry, "body", {
      get() {
        throw new Error("placement recovery must use the immutable receipt");
      },
    });
    const recovered = await finalizePOST(retry, ctx(id));
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      artifact: "already_published",
      placement: {
        requested: { workspaceId, folderId: null },
        actual: { workspaceId, folderId: null },
        outcome: "saved",
      },
    });
    await expect((await organizationPendingGET(
      getRequest("/api/organization-pending?limit=10"),
    )).json()).resolves.toMatchObject({ count: 0, rows: [] });
  });
});
