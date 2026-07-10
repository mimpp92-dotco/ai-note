// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PATCH as patchFolderParent } from "@/app/api/folders/[id]/parent/route";
import { POST as createFolder } from "@/app/api/folders/route";
import { GET as getLibrary } from "@/app/api/library/route";
import {
  GET as getMeetingLocation,
  PATCH as patchMeetingLocation,
} from "@/app/api/meetings/[id]/location/route";
import { POST as createWorkspace } from "@/app/api/workspaces/route";
import type { StatusJson } from "@/domain/meeting";
import { resetLibraryRepositoryStateForTests } from "@/lib/library";
import { ensureFinalizePlacement } from "@/lib/finalizePlacement";
import type { FinalizeReceipt } from "@/lib/finalizeRecord";
import {
  acquireMeetingOperation,
  resetMeetingLifecycleForTests,
} from "@/lib/meetingLifecycle";
import { resetOrganizationPendingStateForTests } from "@/lib/organizationPending";
import { meetingPaths } from "@/lib/paths";
import { initialStatus, readStatus, writeStatus } from "@/lib/status";
import { resetStatusUpdaterStateForTests } from "@/lib/statusUpdater";

const ORIGIN = "http://127.0.0.1:3000";
const HASH = "a".repeat(64);
let workDir: string;
let originalCwd: string;

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", "127.0.0.1:3000");
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") headers.set("origin", ORIGIN);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
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
  writeFileSync(meetingPaths(id).audio, "immutable-audio");
}

async function createWorkspaceAndFolder() {
  const initial = await (await getLibrary(request("/api/library"))).json();
  const workspaceResponse = await createWorkspace(request("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({
      expectedLibraryId: initial.version.libraryId,
      expectedRevision: initial.version.revision,
      name: "업무",
    }),
  }));
  const workspaceBody = await workspaceResponse.json();
  const workspace = workspaceBody.library.workspaces.find((item: { name: string }) => item.name === "업무");
  const folderResponse = await createFolder(request("/api/folders", {
    method: "POST",
    body: JSON.stringify({
      expectedLibraryId: workspaceBody.version.libraryId,
      expectedRevision: workspaceBody.version.revision,
      workspaceId: workspace.id,
      parentFolderId: null,
      name: "프로젝트",
      color: "sage",
    }),
  }));
  const folderBody = await folderResponse.json();
  return {
    body: folderBody,
    workspace,
    folder: folderBody.library.folders.find((item: { name: string }) => item.name === "프로젝트"),
  };
}

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "library-move-routes-"));
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

describe("meeting location move route", () => {
  it("moves a pending meeting cross-workspace without moving or changing artifact bytes", async () => {
    await seedMeeting("meeting-1", {
      placementResolution: { state: "pending", receiptHash: HASH },
    });
    const beforePath = meetingPaths("meeting-1").dir;
    const beforeHash = createHash("sha256").update(readFileSync(meetingPaths("meeting-1").audio)).digest("hex");
    const destination = await createWorkspaceAndFolder();

    const response = await patchMeetingLocation(request("/api/meetings/meeting-1/location", {
      method: "PATCH",
      body: JSON.stringify({
        expectedLibraryId: destination.body.version.libraryId,
        expectedRevision: destination.body.version.revision,
        workspaceId: destination.workspace.id,
        folderId: destination.folder.id,
      }),
    }), params("meeting-1"));
    expect(response.status).toBe(200);
    const moved = await response.json();
    expect(moved.location).toMatchObject({
      workspaceId: destination.workspace.id,
      folderId: destination.folder.id,
      breadcrumb: ["프로젝트"],
    });
    expect(moved.version.revision).toBe(destination.body.version.revision + 1);
    expect(meetingPaths("meeting-1").dir).toBe(beforePath);
    expect(createHash("sha256").update(readFileSync(meetingPaths("meeting-1").audio)).digest("hex"))
      .toBe(beforeHash);
    expect((await readStatus("meeting-1"))?.placementResolution).toEqual({
      state: "resolved",
      receiptHash: HASH,
    });

    const oldReceipt: FinalizeReceipt = {
      schemaVersion: 1,
      id: "meeting-1",
      startedAt: "2026-07-10T00:00:00.000Z",
      endedAt: "2026-07-10T00:01:00.000Z",
      acceptedAt: "2026-07-10T00:01:01.000Z",
      durationMs: 60_000,
      mimeType: "audio/webm",
      requestedLocation: {
        workspaceId: destination.body.library.defaultWorkspaceId,
        folderId: null,
      },
      locationSource: "explicit",
      audioSha256: "b".repeat(64),
    };
    const resumedResolver = await ensureFinalizePlacement({
      meetingId: "meeting-1",
      receipt: oldReceipt,
      receiptHash: HASH,
    });
    expect(resumedResolver.actual).toEqual({
      workspaceId: destination.workspace.id,
      folderId: destination.folder.id,
    });

    const probed = await getMeetingLocation(
      request("/api/meetings/meeting-1/location"),
      params("meeting-1"),
    );
    await expect(probed.json()).resolves.toMatchObject({ location: moved.location });
  });

  it("returns authoritative typed conflicts for stale tokens and missing destinations without fallback", async () => {
    await seedMeeting("meeting-1");
    const destination = await createWorkspaceAndFolder();
    const missingFolder = "40000000-0000-4000-8000-000000000099";
    const missing = await patchMeetingLocation(request("/api/meetings/meeting-1/location", {
      method: "PATCH",
      body: JSON.stringify({
        expectedLibraryId: destination.body.version.libraryId,
        expectedRevision: destination.body.version.revision,
        workspaceId: destination.workspace.id,
        folderId: missingFolder,
      }),
    }), params("meeting-1"));
    expect(missing.status).toBe(409);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "library_destination_conflict" },
      version: destination.body.version,
    });

    const stale = await patchMeetingLocation(request("/api/meetings/meeting-1/location", {
      method: "PATCH",
      body: JSON.stringify({
        expectedLibraryId: destination.body.version.libraryId,
        expectedRevision: 0,
        workspaceId: destination.workspace.id,
        folderId: destination.folder.id,
      }),
    }), params("meeting-1"));
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: { code: "library_revision_conflict" } });

    const location = await (await getMeetingLocation(
      request("/api/meetings/meeting-1/location"),
      params("meeting-1"),
    )).json();
    expect(location.location.folderId).not.toBe(missingFolder);
  });

  it("allows summarize concurrently but conflicts with finalize/delete lifecycle owners", async () => {
    await seedMeeting("meeting-1");
    const initial = await (await getLibrary(request("/api/library"))).json();
    const body = {
      expectedLibraryId: initial.version.libraryId,
      expectedRevision: initial.version.revision,
      workspaceId: initial.library.defaultWorkspaceId,
      folderId: null,
    };
    const finalize = await acquireMeetingOperation("meeting-1", "finalize");
    const blocked = await patchMeetingLocation(request("/api/meetings/meeting-1/location", {
      method: "PATCH",
      body: JSON.stringify(body),
    }), params("meeting-1"));
    expect(blocked.status).toBe(409);
    finalize.release();

    const summarize = await acquireMeetingOperation("meeting-1", "summarize");
    const allowed = await patchMeetingLocation(request("/api/meetings/meeting-1/location", {
      method: "PATCH",
      body: JSON.stringify(body),
    }), params("meeting-1"));
    expect(allowed.status).toBe(200);
    summarize.release();
  });
});

describe("folder parent move route", () => {
  it("reparents within one workspace and rejects cross-workspace targets without partial mutation", async () => {
    const initial = await (await getLibrary(request("/api/library"))).json();
    const workspaceId = initial.library.defaultWorkspaceId;
    let token = initial.version;
    const create = async (name: string, parentFolderId: string | null, workspace = workspaceId) => {
      const response = await createFolder(request("/api/folders", {
        method: "POST",
        body: JSON.stringify({
          expectedLibraryId: token.libraryId,
          expectedRevision: token.revision,
          workspaceId: workspace,
          parentFolderId,
          name,
        }),
      }));
      const body = await response.json();
      token = body.version;
      return body.library.folders.find((item: { name: string }) => item.name === name);
    };
    const source = await create("원본", null);
    const child = await create("하위", source.id);
    const target = await create("대상", null);
    const moved = await patchFolderParent(request(`/api/folders/${child.id}/parent`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedLibraryId: token.libraryId,
        expectedRevision: token.revision,
        parentFolderId: target.id,
      }),
    }), params(child.id));
    expect(moved.status).toBe(200);
    const movedBody = await moved.json();
    token = movedBody.version;
    expect(movedBody.library.folders.find((item: { id: string }) => item.id === child.id))
      .toMatchObject({ parentFolderId: target.id, order: 0 });

    const other = await createWorkspaceAndFolder();
    token = other.body.version;
    const conflict = await patchFolderParent(request(`/api/folders/${source.id}/parent`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedLibraryId: token.libraryId,
        expectedRevision: token.revision,
        parentFolderId: other.folder.id,
      }),
    }), params(source.id));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: "folder_move_conflict" } });
  });
});
