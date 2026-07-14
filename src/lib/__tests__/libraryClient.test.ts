import { describe, expect, it, vi } from "vitest";

import type { PublicLibraryView } from "@/lib/libraryQuery";
import {
  acceptIndependentFreshness,
  acceptVersionedFreshness,
  addPageToWindow,
  applyMeetingMoveToPageWindow,
  createPageWindow,
  createResourcePoller,
  markCurrentPage,
  resetPageWindowForVersion,
  resolveCanonicalLibraryScope,
  resolveDegradedClientModel,
  scopedMeetingPageClientSchema,
  type PageWindow,
} from "@/lib/libraryClient";

const LIBRARY: PublicLibraryView = {
  defaultWorkspaceId: "10000000-0000-4000-8000-000000000001",
  workspaces: [
    {
      id: "10000000-0000-4000-8000-000000000001",
      name: "기본",
      order: 0,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    },
    {
      id: "20000000-0000-4000-8000-000000000002",
      name: "업무",
      order: 1,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    },
  ],
  folders: [{
    id: "30000000-0000-4000-8000-000000000003",
    workspaceId: "20000000-0000-4000-8000-000000000002",
    parentFolderId: null,
    name: "프로젝트",
    color: "sage",
    order: 0,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  }],
  counts: {
    visibleMeetingCount: 0,
    hiddenInvalidStatusCount: 0,
    organizationPendingCount: 0,
    workspaces: [],
    folders: [],
  },
};

describe("scoped meeting page client schema", () => {
  const meetingPagePayload = (extra: Record<string, unknown> = {}) => ({
    mode: "ready" as const,
    version: { libraryId: "571fa0e8-fff7-4b4a-8104-9f07475319ef", revision: 22 },
    meetings: [{
      id: "c56ec2d9-c38b-40e3-a685-3038ccdc6254",
      title: "회의",
      status: "summarized" as const,
      startedAt: "2026-07-13T02:49:01.222Z",
      error: null,
      ...extra,
    }],
    nextCursor: null,
  });

  it("accepts the resummarizeInflight list-DTO field so the meeting page renders", () => {
    // Regression: the server list DTO carries resummarizeInflight (R6); the meeting object
    // is strict, so omitting it here would throw at parse time and the list would silently
    // render empty even though the server returns rows.
    expect(scopedMeetingPageClientSchema.safeParse(meetingPagePayload({ resummarizeInflight: false })).success).toBe(true);
    expect(scopedMeetingPageClientSchema.safeParse(meetingPagePayload()).success).toBe(true);
  });

  it("still rejects a genuinely unknown meeting key", () => {
    expect(scopedMeetingPageClientSchema.safeParse(meetingPagePayload({ bogusField: 1 })).success).toBe(false);
  });
});

describe("library client freshness", () => {
  const current = {
    libraryId: "10000000-0000-4000-8000-000000000010",
    revision: 3,
    sequence: 9,
    operationEpoch: 2,
  };

  it("accepts higher revision despite lower sequence and rejects every lower revision", () => {
    expect(acceptVersionedFreshness(current, {
      ...current,
      revision: 4,
      sequence: 1,
    })).toMatchObject({ accept: true, resetPages: true });
    expect(acceptVersionedFreshness(current, {
      ...current,
      revision: 2,
      sequence: 99,
      operationEpoch: 99,
    })).toEqual({ accept: false, resetPages: false });
  });

  it("uses latest-started sequence only at the same version and rejects pre-mutation polls", () => {
    expect(acceptVersionedFreshness(current, { ...current, sequence: 10 })).toMatchObject({ accept: true });
    expect(acceptVersionedFreshness(current, { ...current, sequence: 8 })).toMatchObject({ accept: false });
    expect(acceptVersionedFreshness(current, {
      ...current,
      sequence: 100,
      operationEpoch: 1,
    })).toMatchObject({ accept: false });
  });

  it("requires an explicit generation transition for a different libraryId", () => {
    const incoming = {
      ...current,
      libraryId: "20000000-0000-4000-8000-000000000020",
      revision: 0,
    };
    expect(acceptVersionedFreshness(current, incoming)).toMatchObject({ accept: false });
    expect(acceptVersionedFreshness(current, incoming, { allowGenerationTransition: true }))
      .toEqual({ accept: true, resetPages: true });
  });

  it("keeps status and organization-pending operation epochs independent of library revision", () => {
    const resource = { sequence: 4, operationEpoch: 3 };
    expect(acceptIndependentFreshness(resource, { sequence: 99, operationEpoch: 2 })).toBe(false);
    expect(acceptIndependentFreshness(resource, { sequence: 5, operationEpoch: 3 })).toBe(true);
    expect(acceptIndependentFreshness(resource, { sequence: 1, operationEpoch: 4 })).toBe(true);
  });
});

function rows(page: number, count = 50) {
  return Array.from({ length: count }, (_, index) => ({
    id: `meeting-${page}-${index}`,
    title: `회의 ${page}-${index}`,
    status: "summarized" as const,
    startedAt: "2026-07-10T00:00:00.000Z",
    error: null,
  }));
}

describe("bounded bidirectional page window", () => {
  it("keeps current ±2, at most five pages/500 entities, but preserves cursor history", () => {
    let cache: PageWindow = createPageWindow("library:1", "workspace:w1");
    for (let page = 0; page < 12; page += 1) {
      cache = addPageToWindow(cache, {
        position: page,
        cursor: page === 0 ? null : `cursor-${page}`,
        nextCursor: page === 11 ? null : `cursor-${page + 1}`,
        rows: rows(page, 100),
      });
      cache = markCurrentPage(cache, page);
    }
    expect([...cache.pages.keys()]).toEqual([9, 10, 11]);
    expect(cache.entities.size).toBe(300);
    expect(cache.cursorHistory.size).toBe(12);

    cache = markCurrentPage(cache, 8);
    expect(cache.pages.has(8)).toBe(false);
    expect(cache.cursorHistory.get(8)).toBe("cursor-8");
    cache = addPageToWindow(cache, {
      position: 8,
      cursor: "cursor-8",
      nextCursor: "cursor-9",
      rows: rows(8, 100),
    });
    expect(cache.pages.has(8)).toBe(true);
    expect(cache.pages.size).toBeLessThanOrEqual(5);
    expect(cache.entities.size).toBeLessThanOrEqual(500);
  });

  it("drops every page/entity/cursor when version or scope generation changes", () => {
    let cache = addPageToWindow(createPageWindow("library:1", "workspace:w1"), {
      position: 0,
      cursor: null,
      nextCursor: "next",
      rows: rows(0),
    });
    cache = resetPageWindowForVersion(cache, "library:2", "folder:f1");
    expect(cache.pages.size).toBe(0);
    expect(cache.entities.size).toBe(0);
    expect(cache.cursorHistory.size).toBe(0);
    expect(cache.versionKey).toBe("library:2");
    expect(cache.scopeKey).toBe("folder:f1");
  });

  it("retains a same-workspace All row but removes a row that left a filtered source", () => {
    const meeting = {
      ...rows(0, 1)[0],
      location: {
        workspaceId: "20000000-0000-4000-8000-000000000002",
        folderId: null,
        breadcrumb: [],
      },
    };
    const all = addPageToWindow(createPageWindow("library:1", "workspace:w"), {
      position: 0,
      cursor: null,
      nextCursor: null,
      rows: [meeting],
    });
    const retained = applyMeetingMoveToPageWindow(all, {
      scope: { kind: "workspace", workspaceId: meeting.location.workspaceId },
      meetingId: meeting.id,
      actual: { workspaceId: meeting.location.workspaceId, folderId: "folder-new" },
      breadcrumb: ["새 폴더"],
      versionKey: "library:2",
    });
    expect(retained.retained).toBe(true);
    expect(retained.pages.entities.get(meeting.id)?.location).toEqual({
      workspaceId: meeting.location.workspaceId,
      folderId: "folder-new",
      breadcrumb: ["새 폴더"],
    });

    const filtered = applyMeetingMoveToPageWindow(all, {
      scope: { kind: "unfiled", workspaceId: meeting.location.workspaceId },
      meetingId: meeting.id,
      actual: { workspaceId: meeting.location.workspaceId, folderId: "folder-new" },
      breadcrumb: ["새 폴더"],
      versionKey: "library:2",
    });
    expect(filtered.retained).toBe(false);
    expect(filtered.pages.entities.has(meeting.id)).toBe(false);
    expect(filtered.pages.pages.get(0)?.ids).not.toContain(meeting.id);
  });
});

describe("canonical scope and degraded model", () => {
  it("canonicalizes missing/invalid/cross-workspace URL exactly once", () => {
    const missing = resolveCanonicalLibraryScope(new URLSearchParams(), LIBRARY);
    expect(missing).toMatchObject({
      replace: true,
      search: `workspace=${LIBRARY.defaultWorkspaceId}`,
      scope: { kind: "workspace", workspaceId: LIBRARY.defaultWorkspaceId },
    });
    expect(resolveCanonicalLibraryScope(new URLSearchParams(missing.search), LIBRARY).replace).toBe(false);

    const cross = resolveCanonicalLibraryScope(new URLSearchParams(
      `workspace=${LIBRARY.defaultWorkspaceId}&folder=30000000-0000-4000-8000-000000000003`,
    ), LIBRARY);
    expect(cross.scope).toEqual({
      kind: "workspace",
      workspaceId: "10000000-0000-4000-8000-000000000001",
    });
    expect(cross.reason).toBe("folder_not_in_workspace");
  });

  it("resolves unfiled/folder URLs and read-only degraded modes", () => {
    expect(resolveCanonicalLibraryScope(new URLSearchParams(
      `workspace=${LIBRARY.defaultWorkspaceId}&view=unfiled`,
    ), LIBRARY).scope).toEqual({ kind: "unfiled", workspaceId: LIBRARY.defaultWorkspaceId });
    expect(resolveCanonicalLibraryScope(new URLSearchParams(
      "workspace=20000000-0000-4000-8000-000000000002&folder=30000000-0000-4000-8000-000000000003",
    ), LIBRARY).scope).toEqual({
      kind: "folder",
      workspaceId: "20000000-0000-4000-8000-000000000002",
      folderId: "30000000-0000-4000-8000-000000000003",
    });
    expect(resolveDegradedClientModel("degraded_last_good", LIBRARY)).toMatchObject({
      kind: "last_good",
      canMutate: false,
      library: LIBRARY,
    });
    expect(resolveDegradedClientModel("degraded_fallback", null)).toMatchObject({
      kind: "global_fallback",
      canMutate: false,
      library: null,
    });
  });
});

describe("resource poller", () => {
  it("is single-flight, pauses hidden work, refreshes on focus, and backs off failures", async () => {
    let visible = true;
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    let rejectFirst: ((error: Error) => void) | null = null;
    const load = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    }));
    const poller = createResourcePoller({
      load,
      isVisible: () => visible,
      schedule: (callback, delay) => {
        scheduled.push({ callback, delay });
        return callback;
      },
      cancel: vi.fn(),
      baseDelayMs: 1_000,
      maxDelayMs: 8_000,
    });
    poller.start();
    poller.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    rejectFirst!(new Error("network"));
    await Promise.resolve();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2); // queued refresh runs after the first settles
    rejectFirst!(new Error("network again"));
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduled.at(-1)?.delay).toBe(4_000);

    visible = false;
    poller.refresh();
    expect(load).toHaveBeenCalledTimes(2);
    visible = true;
    poller.focus();
    expect(load).toHaveBeenCalledTimes(3);
    poller.stop();
  });
});
