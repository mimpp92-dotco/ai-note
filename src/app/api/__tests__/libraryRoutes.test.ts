// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PATCH as patchFolder } from "@/app/api/folders/[id]/route";
import { POST as createFolder } from "@/app/api/folders/route";
import { GET as getLibrary } from "@/app/api/library/route";
import { GET as getMeetings } from "@/app/api/meetings/route";
import { GET as getSummaryWork } from "@/app/api/summary-work/route";
import { PATCH as patchWorkspace } from "@/app/api/workspaces/[id]/route";
import { POST as createWorkspace } from "@/app/api/workspaces/route";
import type { StatusJson } from "@/domain/meeting";
import { resetLibraryRepositoryStateForTests } from "@/lib/library";
import { libraryPath, meetingPaths } from "@/lib/paths";
import { resetSummaryWorkCacheForTests } from "@/lib/summaryWorkCache";
import { initialStatus, readStatus, writeStatus } from "@/lib/status";

const ORIGIN = "http://127.0.0.1:3000";
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

async function seedStatus(id: string, startedAt: string, over: Partial<StatusJson> = {}) {
  await writeStatus(id, {
    ...initialStatus(id, {
      startedAt,
      endedAt: startedAt,
      durationMs: 1,
      audioMime: "audio/webm",
    }),
    ...over,
  });
}

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "library-routes-"));
  process.chdir(workDir);
  resetLibraryRepositoryStateForTests();
  resetSummaryWorkCacheForTests();
});

afterEach(() => {
  process.chdir(originalCwd);
  resetLibraryRepositoryStateForTests();
  resetSummaryWorkCacheForTests();
  rmSync(workDir, { recursive: true, force: true });
});

describe("library query and mutation routes", () => {
  it("bootstraps a ready authoritative view", async () => {
    await seedStatus("legacy-meeting", "2026-07-10T00:00:00.000Z");
    const response = await getLibrary(request("/api/library"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.mode).toBe("ready");
    expect(body.version).toMatchObject({ revision: 0 });
    expect(body.library.workspaces).toHaveLength(1);
    expect(body.library.counts.visibleMeetingCount).toBe(1);
    expect(JSON.stringify(body)).not.toContain("placements");
  });

  it("converges raw-last transcription completion from a library read without opening detail", async () => {
    const id = "restart-completed";
    await seedStatus(id, "2026-07-10T00:00:00.000Z", { status: "transcribing" });
    writeFileSync(meetingPaths(id).raw, "완료된 전사\n");
    const library = await (await getLibrary(request("/api/library"))).json();
    const response = await getMeetings(request(
      `/api/meetings?workspaceId=${library.library.defaultWorkspaceId}&limit=50`,
    ));
    const body = await response.json();
    expect(body.meetings).toEqual([
      expect.objectContaining({ id, status: "transcribed" }),
    ]);
    await vi.waitFor(async () => {
      expect((await readStatus(id))?.status).toBe("transcribed");
    });
  });

  it("creates/renames workspace and folder with tokens; stale 409 returns full current view", async () => {
    const initial = await (await getLibrary(request("/api/library"))).json();
    const token = {
      expectedLibraryId: initial.version.libraryId,
      expectedRevision: initial.version.revision,
    };
    const createdWorkspace = await createWorkspace(request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ ...token, name: "업무" }),
    }));
    expect(createdWorkspace.status).toBe(200);
    const workspaceBody = await createdWorkspace.json();
    expect(workspaceBody.version.revision).toBe(1);
    const workspace = workspaceBody.library.workspaces.find((item: { name: string }) => item.name === "업무");

    const stale = await createWorkspace(request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ ...token, name: "stale" }),
    }));
    expect(stale.status).toBe(409);
    const staleBody = await stale.json();
    expect(staleBody.error.code).toBe("library_revision_conflict");
    expect(staleBody.version.revision).toBe(1);
    expect(staleBody.library.workspaces.some((item: { name: string }) => item.name === "업무")).toBe(true);

    const folder = await createFolder(request("/api/folders", {
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
    expect(folder.status).toBe(200);
    const folderBody = await folder.json();
    const created = folderBody.library.folders[0];
    expect(created).toMatchObject({ name: "프로젝트", color: "sage" });

    const renamed = await patchFolder(request(`/api/folders/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedLibraryId: folderBody.version.libraryId,
        expectedRevision: folderBody.version.revision,
        name: "변경됨",
      }),
    }), params(created.id));
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toMatchObject({ version: { revision: 3 } });

    const workspaceRename = await patchWorkspace(request(`/api/workspaces/${workspace.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedLibraryId: folderBody.version.libraryId,
        expectedRevision: 3,
        name: "업무 공간",
      }),
    }), params(workspace.id));
    expect(workspaceRename.status).toBe(200);
  });

  it("rejects missing token and future reparent fields", async () => {
    expect((await createWorkspace(request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "no token" }),
    }))).status).toBe(400);
    expect((await patchFolder(request("/api/folders/00000000-0000-4000-8000-000000000001", {
      method: "PATCH",
      body: JSON.stringify({
        expectedLibraryId: "00000000-0000-4000-8000-000000000001",
        expectedRevision: 0,
        parentFolderId: null,
      }),
    }), params("00000000-0000-4000-8000-000000000001"))).status).toBe(400);
  });

  it("serves last-good with version:null and fresh fallback after registry corruption", async () => {
    await seedStatus("known", "2026-07-10T00:00:00.000Z");
    await getLibrary(request("/api/library"));
    writeFileSync(libraryPath(), "{");
    await seedStatus("new-after-corrupt", "2026-07-10T01:00:00.000Z");
    const degraded = await (await getLibrary(request("/api/library"))).json();
    expect(degraded).toMatchObject({ mode: "degraded_last_good", version: null, degradedReason: "corrupt" });

    resetLibraryRepositoryStateForTests();
    const fallback = await (await getLibrary(request("/api/library"))).json();
    expect(fallback).toMatchObject({ mode: "degraded_fallback", version: null, library: null });
  });
});

describe("scoped meeting and summary-work routes", () => {
  it("paginates scoped meetings and rejects invalid query combinations", async () => {
    for (let index = 0; index < 55; index += 1) {
      await seedStatus(
        `meeting-${String(index).padStart(2, "0")}`,
        `2026-07-10T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
      );
    }
    const library = await (await getLibrary(request("/api/library"))).json();
    const workspaceId = library.library.defaultWorkspaceId;
    const first = await (await getMeetings(request(`/api/meetings?workspaceId=${workspaceId}`))).json();
    expect(first.meetings).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await (await getMeetings(request(
      `/api/meetings?workspaceId=${workspaceId}&cursor=${encodeURIComponent(first.nextCursor)}`,
    ))).json();
    expect(second.meetings).toHaveLength(5);
    const ids = [...first.meetings, ...second.meetings].map((meeting: { id: string }) => meeting.id);
    expect(new Set(ids).size).toBe(55);

    expect((await getMeetings(request(`/api/meetings?workspaceId=${workspaceId}&folderId=x&view=unfiled`))).status).toBe(400);
    expect((await getMeetings(request("/api/meetings?limit=50"))).status).toBe(400);
  });

  it("returns global processing/attention independently of current library page", async () => {
    await seedStatus("processing", "2026-07-10T03:00:00.000Z", { status: "transcribed" });
    await seedStatus("attention-old", "2026-07-08T00:00:00.000Z", {
      status: "transcribed",
      error: { code: "summary_failed", message: "safe", action: "retry_summary" },
    });
    await seedStatus("attention-new", "2026-07-09T00:00:00.000Z", {
      status: "transcribed",
      error: { code: "summary_failed", message: "safe", action: "retry_summary" },
    });
    const first = await (await getSummaryWork(request("/api/summary-work"))).json();
    expect(first.summaryWork).toMatchObject({ processing: 1, needsAttention: 2 });
    expect(first.summaryWork.attention.meetingId).toBe("attention-old");
    const next = await (await getSummaryWork(request(
      `/api/summary-work?attentionAfter=${encodeURIComponent(first.summaryWork.attention.cursor)}`,
    ))).json();
    expect(next.summaryWork.attention.meetingId).toBe("attention-new");
    expect(JSON.stringify(next)).not.toContain("safe");
  });

  it("keeps fresh-process degraded fallback globally bounded", async () => {
    for (let index = 0; index < 55; index += 1) {
      await seedStatus(
        `fallback-${String(index).padStart(2, "0")}`,
        `2026-07-${String((index % 9) + 1).padStart(2, "0")}T00:00:00.000Z`,
      );
    }
    await getLibrary(request("/api/library"));
    writeFileSync(libraryPath(), "{");
    resetLibraryRepositoryStateForTests();
    const first = await (await getMeetings(request("/api/meetings?view=global&limit=50"))).json();
    expect(first).toMatchObject({ mode: "degraded_fallback", version: null });
    expect(first.meetings).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await (await getMeetings(request(
      `/api/meetings?view=global&limit=50&cursor=${encodeURIComponent(first.nextCursor)}`,
    ))).json();
    expect(second.meetings).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
  });
});
