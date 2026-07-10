import { describe, expect, it } from "vitest";

import type { StatusJson } from "@/domain/meeting";
import {
  classifyMeetingRecord,
  type ClassifiedMeetingRecord,
  type LibraryDocument,
} from "@/domain/library";
import {
  buildLibraryPublicView,
  paginateLibraryMeetings,
} from "@/lib/libraryQuery";

const LIBRARY_ID = "50000000-0000-4000-8000-000000000001";
const WORKSPACE_A = "50000000-0000-4000-8000-000000000002";
const WORKSPACE_B = "50000000-0000-4000-8000-000000000003";
const FOLDER_A = "50000000-0000-4000-8000-000000000004";

function document(): LibraryDocument {
  return {
    schemaVersion: 1,
    libraryId: LIBRARY_ID,
    revision: 7,
    defaultWorkspaceId: WORKSPACE_A,
    workspaces: [
      { id: WORKSPACE_A, name: "A", order: 0, createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" },
      { id: WORKSPACE_B, name: "B", order: 1, createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" },
    ],
    folders: [{
      id: FOLDER_A,
      workspaceId: WORKSPACE_A,
      parentFolderId: null,
      name: "폴더",
      color: "sage",
      order: 0,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    }],
    placements: [],
  };
}

function status(id: string, startedAt: string, over: Partial<StatusJson> = {}): StatusJson {
  return {
    id,
    title: id,
    status: "summarized",
    error: null,
    startedAt,
    endedAt: startedAt,
    durationMs: 1,
    audioMime: "audio/webm",
    whisper: { jobId: null, progress: 1 },
    paths: { audio: "/a", play: "/p", raw: "/r", transcript: "/t", summary: "/s", segments: "/g" },
    review: { participants: [] },
    updatedAt: startedAt,
    ...over,
  };
}

function live(id: string, startedAt: string): ClassifiedMeetingRecord {
  return classifyMeetingRecord({
    entryKind: "published",
    meetingId: id,
    safety: "safe",
    status: { kind: "valid", value: status(id, startedAt) },
    hasAudio: true,
  });
}

describe("library public view and counts", () => {
  it("counts visible meetings once by workspace/unfiled/direct folder", () => {
    const doc = document();
    const records = [
      live("m-folder", "2026-07-10T03:00:00.000Z"),
      live("m-unfiled", "2026-07-10T02:00:00.000Z"),
      live("m-other", "2026-07-10T01:00:00.000Z"),
      classifyMeetingRecord({
        entryKind: "published",
        meetingId: "m-corrupt",
        safety: "safe",
        status: { kind: "corrupt" },
        hasAudio: true,
        hasPlacement: true,
      }),
    ];
    const placements = [
      { meetingId: "m-folder", workspaceId: WORKSPACE_A, folderId: FOLDER_A },
      { meetingId: "m-unfiled", workspaceId: WORKSPACE_A, folderId: null },
      { meetingId: "m-other", workspaceId: WORKSPACE_B, folderId: null },
      { meetingId: "m-corrupt", workspaceId: WORKSPACE_A, folderId: null },
    ];
    expect(buildLibraryPublicView(doc, records, placements).counts).toEqual({
      visibleMeetingCount: 3,
      hiddenInvalidStatusCount: 1,
      organizationPendingCount: 0,
      workspaces: [
        { workspaceId: WORKSPACE_A, total: 2, unfiled: 1 },
        { workspaceId: WORKSPACE_B, total: 1, unfiled: 1 },
      ],
      folders: [{ folderId: FOLDER_A, direct: 1 }],
    });
  });
});

describe("scoped cursor pagination", () => {
  it("paginates 120 rows with a stable 50 default and no duplicates", () => {
    const doc = document();
    const records = Array.from({ length: 120 }, (_, index) =>
      live(`m-${String(index).padStart(3, "0")}`, `2026-07-10T00:${String(index % 60).padStart(2, "0")}:00.000Z`));
    const placements = records.map((record) => ({
      meetingId: record.meetingId as string,
      workspaceId: WORKSPACE_A,
      folderId: null,
    }));

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = paginateLibraryMeetings({
        document: doc,
        records,
        placements,
        scope: { kind: "workspace", workspaceId: WORKSPACE_A },
        cursor,
      });
      expect(page.meetings.length).toBeLessThanOrEqual(50);
      seen.push(...page.meetings.map((meeting) => meeting.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });

  it("filters All/unfiled/direct folder and includes breadcrumb only where useful", () => {
    const doc = document();
    const records = [live("folder", "2026-07-10T02:00:00.000Z"), live("unfiled", "2026-07-10T01:00:00.000Z")];
    const placements = [
      { meetingId: "folder", workspaceId: WORKSPACE_A, folderId: FOLDER_A },
      { meetingId: "unfiled", workspaceId: WORKSPACE_A, folderId: null },
    ];
    const all = paginateLibraryMeetings({ document: doc, records, placements, scope: { kind: "workspace", workspaceId: WORKSPACE_A } });
    expect(all.meetings.map((meeting) => meeting.id)).toEqual(["folder", "unfiled"]);
    expect(all.meetings[0].location?.breadcrumb).toEqual(["폴더"]);
    expect(paginateLibraryMeetings({ document: doc, records, placements, scope: { kind: "unfiled", workspaceId: WORKSPACE_A } }).meetings.map((m) => m.id)).toEqual(["unfiled"]);
    expect(paginateLibraryMeetings({ document: doc, records, placements, scope: { kind: "folder", workspaceId: WORKSPACE_A, folderId: FOLDER_A } }).meetings.map((m) => m.id)).toEqual(["folder"]);
  });

  it("caps pages at 100 and rejects malformed/generation/scope cursors", () => {
    const doc = document();
    const records = [live("m", "2026-07-10T00:00:00.000Z")];
    const placements = [{ meetingId: "m", workspaceId: WORKSPACE_A, folderId: null }];
    expect(paginateLibraryMeetings({ document: doc, records, placements, scope: { kind: "workspace", workspaceId: WORKSPACE_A }, limit: 999 }).meetings).toHaveLength(1);
    expect(() => paginateLibraryMeetings({ document: doc, records, placements, scope: { kind: "workspace", workspaceId: WORKSPACE_A }, cursor: "not-a-cursor" })).toThrowError("invalid_meeting_cursor");

    const first = paginateLibraryMeetings({ document: doc, records: [...records, live("older", "2026-07-09T00:00:00.000Z")], placements: [...placements, { meetingId: "older", workspaceId: WORKSPACE_A, folderId: null }], scope: { kind: "workspace", workspaceId: WORKSPACE_A }, limit: 1 });
    expect(() => paginateLibraryMeetings({ document: { ...doc, revision: 8 }, records, placements, scope: { kind: "workspace", workspaceId: WORKSPACE_A }, cursor: first.nextCursor })).toThrowError("stale_meeting_cursor");
    expect(() => paginateLibraryMeetings({ document: doc, records, placements, scope: { kind: "unfiled", workspaceId: WORKSPACE_A }, cursor: first.nextCursor })).toThrowError("stale_meeting_cursor");
  });

  it("keeps 5,000 meetings and 1,000 folders bounded across more than twelve pages", () => {
    const base = Date.parse("2026-07-10T12:00:00.000Z");
    const folders = Array.from({ length: 1_000 }, (_, index) => ({
      id: `folder-${String(index).padStart(4, "0")}`,
      workspaceId: WORKSPACE_A,
      parentFolderId: null,
      name: `폴더 ${index}`,
      color: "sage" as const,
      order: index,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    }));
    const doc: LibraryDocument = { ...document(), folders };
    const records = Array.from({ length: 5_000 }, (_, index) => (
      live(`scale-${String(index).padStart(4, "0")}`, new Date(base - index * 1_000).toISOString())
    ));
    const placements = records.map((record, index) => ({
      meetingId: record.meetingId as string,
      workspaceId: WORKSPACE_A,
      folderId: index % 5 === 0 ? folders[index % folders.length].id : null,
    }));
    const view = buildLibraryPublicView(doc, records, placements);
    expect(view.counts.visibleMeetingCount).toBe(5_000);
    expect(view.counts.folders).toHaveLength(1_000);

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 13; pageIndex += 1) {
      const page = paginateLibraryMeetings({
        document: doc,
        records,
        placements,
        scope: { kind: "workspace", workspaceId: WORKSPACE_A },
        cursor,
        limit: 100,
      });
      expect(page.meetings).toHaveLength(100);
      for (const meeting of page.meetings) {
        expect(seen.has(meeting.id)).toBe(false);
        seen.add(meeting.id);
      }
      cursor = page.nextCursor;
      expect(cursor).not.toBeNull();
    }
    expect(seen.size).toBe(1_300);
    expect(() => paginateLibraryMeetings({
      document: { ...doc, libraryId: "60000000-0000-4000-8000-000000000006", revision: 0 },
      records,
      placements,
      scope: { kind: "workspace", workspaceId: WORKSPACE_A },
      cursor,
      limit: 100,
    })).toThrowError("stale_meeting_cursor");
  });
});
