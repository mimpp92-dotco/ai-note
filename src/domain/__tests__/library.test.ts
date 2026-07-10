import { describe, expect, it } from "vitest";

import type { StatusJson } from "@/domain/meeting";
import {
  classifyMeetingRecord,
  compareLibraryOrder,
  countMeetingRecords,
  libraryNameKey,
  parseLibraryDocument,
  parseStatusJson,
  parseStatusJsonText,
  type LibraryDocument,
  type MeetingRecordObservation,
} from "@/domain/library";

const LIBRARY_ID = "00000000-0000-4000-8000-000000000001";
const WORKSPACE_A = "00000000-0000-4000-8000-000000000002";
const WORKSPACE_B = "00000000-0000-4000-8000-000000000003";
const ROOT_FOLDER = "00000000-0000-4000-8000-000000000004";
const CHILD_FOLDER = "00000000-0000-4000-8000-000000000005";
const GRANDCHILD_FOLDER = "00000000-0000-4000-8000-000000000006";

function status(id = "meeting-1"): StatusJson {
  return {
    id,
    title: "회의",
    status: "recorded",
    error: null,
    startedAt: "2026-07-10T01:00:00.000Z",
    endedAt: "2026-07-10T02:00:00.000Z",
    durationMs: 3_600_000,
    audioMime: "audio/webm",
    whisper: { jobId: null, progress: 0 },
    paths: {
      audio: "/local/audio.webm",
      play: "/local/play.webm",
      raw: "/local/raw.md",
      transcript: "/local/transcript.md",
      summary: "/local/summary.json",
      segments: "/local/segments.json",
    },
    review: { participants: [] },
    updatedAt: "2026-07-10T02:00:00.000Z",
  };
}

function document(overrides: Partial<LibraryDocument> = {}): LibraryDocument {
  return {
    schemaVersion: 1,
    libraryId: LIBRARY_ID,
    revision: 0,
    defaultWorkspaceId: WORKSPACE_A,
    workspaces: [
      {
        id: WORKSPACE_A,
        name: "내 워크스페이스",
        order: 0,
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z",
      },
      {
        id: WORKSPACE_B,
        name: "두 번째",
        order: 1,
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z",
      },
    ],
    folders: [
      {
        id: ROOT_FOLDER,
        workspaceId: WORKSPACE_A,
        parentFolderId: null,
        name: "프로젝트",
        color: "brown",
        order: 0,
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z",
      },
      {
        id: CHILD_FOLDER,
        workspaceId: WORKSPACE_A,
        parentFolderId: ROOT_FOLDER,
        name: "기획",
        color: "sage",
        order: 0,
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z",
      },
    ],
    placements: [
      { meetingId: "meeting-1", workspaceId: WORKSPACE_A, folderId: CHILD_FOLDER },
    ],
    ...overrides,
  };
}

describe("library structural domain", () => {
  it("accepts a valid v1 tree and returns a detached value", () => {
    const input = document();
    const parsed = parseLibraryDocument(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
  });

  it.each([
    ["wrong schema", { schemaVersion: 2 }],
    ["non UUID library id", { libraryId: "library" }],
    ["negative revision", { revision: -1 }],
    ["unsafe revision", { revision: Number.MAX_SAFE_INTEGER + 1 }],
    ["no workspace", { workspaces: [] }],
    ["missing default", { defaultWorkspaceId: "00000000-0000-4000-8000-000000000099" }],
  ])("rejects %s", (_label, change) => {
    expect(() => parseLibraryDocument(document(change as Partial<LibraryDocument>))).toThrow();
  });

  it("rejects duplicate entity IDs and duplicate placement meeting IDs", () => {
    const base = document();
    expect(() =>
      parseLibraryDocument({ ...base, workspaces: [...base.workspaces, base.workspaces[0]] }),
    ).toThrow();
    expect(() =>
      parseLibraryDocument({ ...base, folders: [...base.folders, base.folders[0]] }),
    ).toThrow();
    expect(() =>
      parseLibraryDocument({
        ...base,
        placements: [...base.placements, { ...base.placements[0], folderId: null }],
      }),
    ).toThrow();
  });

  it("rejects missing/cross-workspace folder references, cycles, and depth over three", () => {
    const base = document();
    expect(() =>
      parseLibraryDocument({
        ...base,
        folders: [{ ...base.folders[1], parentFolderId: ROOT_FOLDER, workspaceId: WORKSPACE_B }],
      }),
    ).toThrow();

    expect(() =>
      parseLibraryDocument({
        ...base,
        folders: base.folders.map((folder) =>
          folder.id === ROOT_FOLDER ? { ...folder, parentFolderId: CHILD_FOLDER } : folder,
        ),
      }),
    ).toThrow();

    expect(() =>
      parseLibraryDocument({
        ...base,
        folders: [
          ...base.folders,
          {
            ...base.folders[1],
            id: GRANDCHILD_FOLDER,
            parentFolderId: CHILD_FOLDER,
            name: "세 단계",
          },
          {
            ...base.folders[1],
            id: "00000000-0000-4000-8000-000000000007",
            parentFolderId: GRANDCHILD_FOLDER,
            name: "네 단계",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects dangling and cross-workspace placements", () => {
    const base = document();
    expect(() =>
      parseLibraryDocument({
        ...base,
        placements: [{ meetingId: "meeting-1", workspaceId: WORKSPACE_B, folderId: CHILD_FOLDER }],
      }),
    ).toThrow();
    expect(() =>
      parseLibraryDocument({
        ...base,
        placements: [{
          meetingId: "meeting-1",
          workspaceId: WORKSPACE_A,
          folderId: "00000000-0000-4000-8000-000000000099",
        }],
      }),
    ).toThrow();
  });

  it("normalizes duplicate keys without changing display text", () => {
    expect(libraryNameKey("  Ａ\u00a0  Team  ")).toBe("a team");
    const base = document();
    expect(() =>
      parseLibraryDocument({
        ...base,
        workspaces: [...base.workspaces, {
          ...base.workspaces[1],
          id: "00000000-0000-4000-8000-000000000010",
          name: "  내\u2003워크스페이스 ",
        }],
      }),
    ).toThrow();
  });

  it("enforces name, color, and order rules", () => {
    const base = document();
    for (const name of ["", "\n", "hello\u202Eworld", "a".repeat(81)]) {
      expect(() =>
        parseLibraryDocument({
          ...base,
          workspaces: [{ ...base.workspaces[0], name }],
          defaultWorkspaceId: WORKSPACE_A,
        }),
      ).toThrow();
    }
    expect(() =>
      parseLibraryDocument({ ...base, folders: [{ ...base.folders[0], color: "purple" as "brown" }] }),
    ).toThrow();
    expect(() =>
      parseLibraryDocument({ ...base, folders: [{ ...base.folders[0], order: -1 }] }),
    ).toThrow();
  });

  it("sorts equal orders deterministically by ID", () => {
    const items = [{ id: "b", order: 1 }, { id: "a", order: 1 }, { id: "z", order: 0 }];
    expect([...items].sort(compareLibraryOrder).map((item) => item.id)).toEqual(["z", "a", "b"]);
  });
});

describe("runtime StatusJson contract", () => {
  it("normalizes legacy review in memory and preserves unknown future fields", () => {
    const legacy = Object.fromEntries(
      Object.entries(status()).filter(([key]) => key !== "review"),
    );
    const parsed = parseStatusJson({ ...legacy, futureProtocol: { phase: "new" } }, "meeting-1");
    expect(parsed.review).toEqual({ participants: [] });
    expect((parsed as StatusJson & { futureProtocol: unknown }).futureProtocol).toEqual({ phase: "new" });
    expect(legacy).not.toHaveProperty("review");
  });

  it("rejects malformed JSON, invalid known fields, and directory/status ID mismatch", () => {
    expect(() => parseStatusJsonText("{", "meeting-1")).toThrow();
    expect(() => parseStatusJson({ ...status(), durationMs: -1 }, "meeting-1")).toThrow();
    expect(() => parseStatusJson(status("meeting-2"), "meeting-1")).toThrow();
  });
});

describe("meeting record classifier", () => {
  function observation(
    overrides: Partial<MeetingRecordObservation> = {},
  ): MeetingRecordObservation {
    return {
      entryKind: "published",
      meetingId: "meeting-1",
      safety: "safe",
      status: { kind: "valid", value: status() },
      hasAudio: true,
      hasPlacement: true,
      ...overrides,
    };
  }

  it.each([
    ["live", observation()],
    ["corrupt_status", observation({ status: { kind: "corrupt" } })],
    ["unreadable_status", observation({ status: { kind: "unreadable", code: "EACCES" } })],
    ["unsafe_record", observation({ safety: "unsafe" })],
    ["incomplete", observation({ status: { kind: "missing" }, hasAudio: false })],
    ["hidden_staging", observation({ entryKind: "finalize_staging" })],
    ["hidden_staging", observation({ entryKind: "summarize_staging" })],
    ["hidden_deleted", observation({ entryKind: "deleted" })],
    ["unsafe_record", observation({ entryKind: "delete_ambiguous" })],
    ["incomplete", observation({ entryKind: "unknown" })],
  ] as const)("classifies %s", (expected, input) => {
    expect(classifyMeetingRecord(input).kind).toBe(expected);
  });

  it("treats a valid legacy status-only directory as live", () => {
    expect(classifyMeetingRecord(observation({ hasAudio: false })).kind).toBe("live");
  });

  it("keeps counting after invalid records and separates count meanings", () => {
    const records = [
      classifyMeetingRecord(observation()),
      classifyMeetingRecord(observation({ meetingId: "meeting-2", status: { kind: "corrupt" } })),
      classifyMeetingRecord(observation({
        meetingId: "meeting-3",
        status: { kind: "unreadable", code: "short_read" },
        hasPlacement: false,
      })),
      classifyMeetingRecord(observation({ meetingId: "meeting-4", safety: "unsafe" })),
      classifyMeetingRecord(observation({ meetingId: "meeting-5", entryKind: "deleted" })),
    ];
    expect(countMeetingRecords(records)).toEqual({
      visibleMeetingCount: 1,
      affectedPlacementCount: 2,
      hiddenInvalidStatusCount: 3,
    });
  });

  it("does not mutate its typed observation", () => {
    const input = observation({ status: { kind: "corrupt" } });
    const before = structuredClone(input);
    expect(classifyMeetingRecord(input)).toEqual(classifyMeetingRecord(input));
    expect(input).toEqual(before);
  });
});
