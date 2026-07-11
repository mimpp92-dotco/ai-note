// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as previewFolderDelete } from "@/app/api/folders/[id]/delete-preview/route";
import { DELETE as deleteFolder } from "@/app/api/folders/[id]/route";
import { GET as getLibrary } from "@/app/api/library/route";
import { GET as getMeetingLocation } from "@/app/api/meetings/[id]/location/route";
import { GET as previewWorkspaceDelete } from "@/app/api/workspaces/[id]/delete-preview/route";
import { DELETE as deleteWorkspace } from "@/app/api/workspaces/[id]/route";
import type { StatusJson } from "@/domain/meeting";
import { createFolder, createWorkspace, moveMeetingPlacement } from "@/domain/libraryMutations";
import { createLibraryRepository, resetLibraryRepositoryStateForTests } from "@/lib/library";
import { ensureFinalizePlacement } from "@/lib/finalizePlacement";
import { readFinalizeReceipt } from "@/lib/finalizeRecord";
import { resetMeetingLifecycleForTests } from "@/lib/meetingLifecycle";
import { resetOrganizationPendingStateForTests } from "@/lib/organizationPending";
import { dataRoot, finalizeReceiptPath, meetingPaths } from "@/lib/paths";
import { initialStatus, writeStatus } from "@/lib/status";
import { resetStatusUpdaterStateForTests } from "@/lib/statusUpdater";

const ORIGIN = "http://127.0.0.1:3000";
const WORKSPACE_B = "20000000-0000-4000-8000-000000000002";
const PARENT = "30000000-0000-4000-8000-000000000003";
const DELETED_FOLDER = "30000000-0000-4000-8000-000000000004";
const CHILD = "30000000-0000-4000-8000-000000000005";
const NOW = "2026-07-10T00:00:00.000Z";
let workDir: string;
let originalCwd: string;

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", "127.0.0.1:3000");
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") headers.set("origin", ORIGIN);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function seedMeeting(id: string, over: Partial<StatusJson> = {}) {
  await writeStatus(id, {
    ...initialStatus(id, {
      startedAt: NOW,
      endedAt: "2026-07-10T00:01:00.000Z",
      durationMs: 60_000,
      audioMime: "audio/webm",
    }),
    ...over,
  });
  writeFileSync(meetingPaths(id).audio, `immutable-${id}`);
}

async function seedStructure(options: { placeMeeting?: boolean } = {}) {
  const initial = await (await getLibrary(request("/api/library"))).json();
  const defaultWorkspaceId = initial.library.defaultWorkspaceId as string;
  const repository = createLibraryRepository({ dataRoot: dataRoot() });
  const transaction = await repository.transactLatest((document) => {
    let next = createWorkspace(document, { id: WORKSPACE_B, name: "개인", now: NOW });
    next = createFolder(next, {
      id: PARENT,
      workspaceId: defaultWorkspaceId,
      parentFolderId: null,
      name: "상위",
      now: NOW,
    });
    next = createFolder(next, {
      id: DELETED_FOLDER,
      workspaceId: defaultWorkspaceId,
      parentFolderId: PARENT,
      name: "정리 대상",
      now: NOW,
    });
    next = createFolder(next, {
      id: CHILD,
      workspaceId: defaultWorkspaceId,
      parentFolderId: DELETED_FOLDER,
      name: "보존할 자식",
      now: NOW,
    });
    if (options.placeMeeting) {
      next = moveMeetingPlacement(next, {
        meetingId: "meeting-1",
        workspaceId: defaultWorkspaceId,
        folderId: DELETED_FOLDER,
      });
    }
    return next;
  });
  return { defaultWorkspaceId, version: transaction.version };
}

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "library-container-delete-"));
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

describe("folder preservation delete routes", () => {
  it("previews and commits latest meeting rehome/child promotion without changing artifact bytes", async () => {
    await seedMeeting("meeting-1");
    const seeded = await seedStructure({ placeMeeting: true });
    const beforeHash = createHash("sha256").update(readFileSync(meetingPaths("meeting-1").audio)).digest("hex");
    const preview = await previewFolderDelete(
      request(`/api/folders/${DELETED_FOLDER}/delete-preview`),
      params(DELETED_FOLDER),
    );
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody).toMatchObject({
      version: seeded.version,
      impact: {
        directVisibleMeetingCount: 1,
        affectedPlacementCount: 1,
        directChildFolderCount: 1,
        target: { workspaceId: seeded.defaultWorkspaceId, folderId: PARENT },
        artifactPolicy: "meeting_artifacts_preserved",
      },
    });

    const committed = await deleteFolder(request(`/api/folders/${DELETED_FOLDER}`, {
      method: "DELETE",
      body: JSON.stringify({
        expectedLibraryId: previewBody.version.libraryId,
        expectedRevision: previewBody.version.revision,
      }),
    }), params(DELETED_FOLDER));
    expect(committed.status).toBe(200);
    const body = await committed.json();
    expect(body.impact).toMatchObject(previewBody.impact);
    expect(body.redirect).toEqual({ workspaceId: seeded.defaultWorkspaceId, folderId: PARENT });
    expect(body.library.folders.some((folder: { id: string }) => folder.id === DELETED_FOLDER)).toBe(false);
    expect(body.library.folders.find((folder: { id: string }) => folder.id === CHILD))
      .toMatchObject({ parentFolderId: PARENT });
    const location = await (await getMeetingLocation(
      request("/api/meetings/meeting-1/location"),
      params("meeting-1"),
    )).json();
    expect(location.location).toMatchObject({ workspaceId: seeded.defaultWorkspaceId, folderId: PARENT });
    expect(createHash("sha256").update(readFileSync(meetingPaths("meeting-1").audio)).digest("hex"))
      .toBe(beforeHash);
  });

  it("counts pending immutable location intents and delete-first makes the resolver fall back later", async () => {
    await seedMeeting("pending", {
      placementResolution: { state: "pending", receiptHash: "a".repeat(64) },
    });
    const seeded = await seedStructure();
    writeFileSync(finalizeReceiptPath("pending"), `${JSON.stringify({
      schemaVersion: 1,
      id: "pending",
      startedAt: NOW,
      endedAt: "2026-07-10T00:01:00.000Z",
      acceptedAt: "2026-07-10T00:01:01.000Z",
      durationMs: 60_000,
      mimeType: "audio/webm",
      requestedLocation: { workspaceId: seeded.defaultWorkspaceId, folderId: DELETED_FOLDER },
      locationSource: "explicit",
      audioSha256: "b".repeat(64),
    })}\n`);
    const previewBody = await (await previewFolderDelete(
      request(`/api/folders/${DELETED_FOLDER}/delete-preview`),
      params(DELETED_FOLDER),
    )).json();
    expect(previewBody.impact.pendingLocationIntentCount).toBe(1);
    const deleted = await deleteFolder(request(`/api/folders/${DELETED_FOLDER}`, {
      method: "DELETE",
      body: JSON.stringify({
        expectedLibraryId: previewBody.version.libraryId,
        expectedRevision: previewBody.version.revision,
      }),
    }), params(DELETED_FOLDER));
    expect(deleted.status).toBe(200);
    const receipt = await readFinalizeReceipt("pending");
    expect(receipt).not.toBeNull();
    const resolved = await ensureFinalizePlacement({
      meetingId: "pending",
      receipt: receipt!,
      receiptHash: "a".repeat(64),
    });
    expect(resolved).toMatchObject({
      actual: { workspaceId: seeded.defaultWorkspaceId, folderId: null },
      outcome: "fallback",
      fallbackReason: "folder_missing",
    });
  });

  it("rejects a stale preview token after a concurrent library mutation", async () => {
    await seedMeeting("meeting-1");
    await seedStructure({ placeMeeting: true });
    const preview = await (await previewFolderDelete(
      request(`/api/folders/${DELETED_FOLDER}/delete-preview`),
      params(DELETED_FOLDER),
    )).json();
    const repository = createLibraryRepository({ dataRoot: dataRoot() });
    await repository.transactLatest((document) => createFolder(document, {
      id: "30000000-0000-4000-8000-000000000099",
      workspaceId: preview.impact.workspaceId,
      parentFolderId: PARENT,
      name: "동시 생성",
      now: NOW,
    }));
    const stale = await deleteFolder(request(`/api/folders/${DELETED_FOLDER}`, {
      method: "DELETE",
      body: JSON.stringify({
        expectedLibraryId: preview.version.libraryId,
        expectedRevision: preview.version.revision,
      }),
    }), params(DELETED_FOLDER));
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: { code: "library_revision_conflict" } });
  });
});

describe("workspace preservation delete routes", () => {
  it("requires a different destination, moves meetings to its unfiled, and changes default", async () => {
    await seedMeeting("meeting-1");
    const seeded = await seedStructure();
    const preview = await previewWorkspaceDelete(
      request(`/api/workspaces/${seeded.defaultWorkspaceId}/delete-preview`),
      params(seeded.defaultWorkspaceId),
    );
    const previewBody = await preview.json();
    expect(previewBody.impact).toMatchObject({
      visibleMeetingCount: 1,
      affectedPlacementCount: 1,
      folderCount: 3,
      destinationCandidates: [{ id: WORKSPACE_B, name: "개인" }],
      lastWorkspaceBlocked: false,
    });
    const committed = await deleteWorkspace(request(`/api/workspaces/${seeded.defaultWorkspaceId}`, {
      method: "DELETE",
      body: JSON.stringify({
        expectedLibraryId: previewBody.version.libraryId,
        expectedRevision: previewBody.version.revision,
        destinationWorkspaceId: WORKSPACE_B,
      }),
    }), params(seeded.defaultWorkspaceId));
    expect(committed.status).toBe(200);
    const body = await committed.json();
    expect(body.library.defaultWorkspaceId).toBe(WORKSPACE_B);
    expect(body.redirect).toEqual({ workspaceId: WORKSPACE_B, folderId: null });
    const location = await (await getMeetingLocation(
      request("/api/meetings/meeting-1/location"),
      params("meeting-1"),
    )).json();
    expect(location.location).toMatchObject({ workspaceId: WORKSPACE_B, folderId: null });
  });

  it("marks the last workspace blocked and refuses commit", async () => {
    const initial = await (await getLibrary(request("/api/library"))).json();
    const workspaceId = initial.library.defaultWorkspaceId;
    const preview = await previewWorkspaceDelete(
      request(`/api/workspaces/${workspaceId}/delete-preview`),
      params(workspaceId),
    );
    const body = await preview.json();
    expect(body.impact).toMatchObject({ lastWorkspaceBlocked: true, blockedReason: "last_workspace" });
    const committed = await deleteWorkspace(request(`/api/workspaces/${workspaceId}`, {
      method: "DELETE",
      body: JSON.stringify({
        expectedLibraryId: body.version.libraryId,
        expectedRevision: body.version.revision,
        destinationWorkspaceId: workspaceId,
      }),
    }), params(workspaceId));
    expect(committed.status).toBe(409);
    await expect(committed.json()).resolves.toMatchObject({ error: { code: "container_delete_conflict" } });
  });
});
