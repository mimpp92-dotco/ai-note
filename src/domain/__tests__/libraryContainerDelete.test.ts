import { describe, expect, it } from "vitest";

import type { ClassifiedMeetingRecord, LibraryDocument } from "@/domain/library";
import {
  calculateFolderDeleteImpact,
  calculateWorkspaceDeleteImpact,
  deleteFolderPreservingMeetings,
  deleteWorkspacePreservingMeetings,
} from "@/domain/libraryContainerDelete";

const LIBRARY_ID = "40000000-0000-4000-8000-000000000001";
const WORKSPACE_A = "40000000-0000-4000-8000-000000000002";
const WORKSPACE_B = "40000000-0000-4000-8000-000000000003";
const PARENT = "40000000-0000-4000-8000-000000000004";
const DELETE = "40000000-0000-4000-8000-000000000005";
const SIBLING = "40000000-0000-4000-8000-000000000006";
const CHILD_A = "40000000-0000-4000-8000-000000000007";
const CHILD_B = "40000000-0000-4000-8000-000000000008";
const OTHER_FOLDER = "40000000-0000-4000-8000-000000000010";
const NOW = "2026-07-10T00:00:00.000Z";

function folder(id: string, workspaceId: string, parentFolderId: string | null, name: string, order: number) {
  return { id, workspaceId, parentFolderId, name, order, color: "brown" as const, createdAt: NOW, updatedAt: NOW };
}

function document(): LibraryDocument {
  return {
    schemaVersion: 1,
    libraryId: LIBRARY_ID,
    revision: 7,
    defaultWorkspaceId: WORKSPACE_A,
    workspaces: [
      { id: WORKSPACE_A, name: "업무", order: 0, createdAt: NOW, updatedAt: NOW },
      { id: WORKSPACE_B, name: "개인", order: 1, createdAt: NOW, updatedAt: NOW },
    ],
    folders: [
      folder(PARENT, WORKSPACE_A, null, "상위", 0),
      folder(SIBLING, WORKSPACE_A, PARENT, "기존", 0),
      folder(DELETE, WORKSPACE_A, PARENT, "삭제할 폴더", 1),
      folder(CHILD_A, WORKSPACE_A, DELETE, "자식 A", 0),
      folder(CHILD_B, WORKSPACE_A, DELETE, "자식 B", 1),
      folder(OTHER_FOLDER, WORKSPACE_B, null, "개인 폴더", 0),
    ],
    placements: [
      { meetingId: "visible", workspaceId: WORKSPACE_A, folderId: DELETE },
      { meetingId: "hidden", workspaceId: WORKSPACE_A, folderId: DELETE },
      { meetingId: "nested", workspaceId: WORKSPACE_A, folderId: CHILD_A },
      { meetingId: "other", workspaceId: WORKSPACE_B, folderId: OTHER_FOLDER },
    ],
  };
}

function record(meetingId: string, visible: boolean): ClassifiedMeetingRecord {
  return {
    kind: visible ? "live" : "corrupt_status",
    meetingId,
    hasPlacement: true,
    visible,
    preservePlacement: true,
    status: null,
  };
}

const records = [record("visible", true), record("hidden", false), record("nested", true), record("other", true)];

describe("folder preservation delete", () => {
  it("shares honest impact counts with commit and preserves meetings/children/order", () => {
    const input = document();
    const before = structuredClone(input);
    const impact = calculateFolderDeleteImpact(input, {
      folderId: DELETE,
      records,
      pendingLocationIntentCount: 3,
    });
    expect(impact).toMatchObject({
      directVisibleMeetingCount: 1,
      affectedPlacementCount: 2,
      hiddenInvalidStatusPlacementCount: 1,
      pendingLocationIntentCount: 3,
      directChildFolderCount: 2,
      target: { workspaceId: WORKSPACE_A, folderId: PARENT },
      promotionConflicts: [],
      artifactPolicy: "meeting_artifacts_preserved",
    });

    const result = deleteFolderPreservingMeetings(input, {
      folderId: DELETE,
      records,
      pendingLocationIntentCount: 3,
    });
    expect(result.document.folders.some((candidate) => candidate.id === DELETE)).toBe(false);
    expect(result.document.folders.find((candidate) => candidate.id === CHILD_A)).toMatchObject({
      parentFolderId: PARENT,
      order: 1,
    });
    expect(result.document.folders.find((candidate) => candidate.id === CHILD_B)).toMatchObject({
      parentFolderId: PARENT,
      order: 2,
    });
    expect(result.document.placements.filter((placement) => ["visible", "hidden"].includes(placement.meetingId)))
      .toEqual([
        { meetingId: "visible", workspaceId: WORKSPACE_A, folderId: PARENT },
        { meetingId: "hidden", workspaceId: WORKSPACE_A, folderId: PARENT },
      ]);
    expect(input).toEqual(before);
  });

  it("rehomes root-folder meetings to unfiled", () => {
    const result = deleteFolderPreservingMeetings(document(), {
      folderId: PARENT,
      records,
      pendingLocationIntentCount: 0,
    });
    expect(result.impact.target).toEqual({ workspaceId: WORKSPACE_A, folderId: null });
  });

  it("detects every promotion conflict and rolls the whole transform back", () => {
    const input = document();
    const conflicting = {
      ...input,
      folders: [
        ...input.folders,
        folder("40000000-0000-4000-8000-000000000011", WORKSPACE_A, PARENT, "자식 A", 2),
      ],
    };
    const before = structuredClone(conflicting);
    const impact = calculateFolderDeleteImpact(conflicting, {
      folderId: DELETE,
      records,
      pendingLocationIntentCount: 0,
    });
    expect(impact.promotionConflicts).toEqual([
      expect.objectContaining({ promotedFolderId: CHILD_A }),
    ]);
    expect(() => deleteFolderPreservingMeetings(conflicting, {
      folderId: DELETE,
      records,
      pendingLocationIntentCount: 0,
    })).toThrowError("folder_delete_conflict");
    expect(conflicting).toEqual(before);
  });
});

describe("workspace preservation delete", () => {
  it("moves every source placement to destination unfiled and changes default atomically", () => {
    const input = document();
    const before = structuredClone(input);
    const impact = calculateWorkspaceDeleteImpact(input, {
      workspaceId: WORKSPACE_A,
      records,
      pendingLocationIntentCount: 2,
    });
    expect(impact).toMatchObject({
      visibleMeetingCount: 2,
      affectedPlacementCount: 3,
      hiddenInvalidStatusPlacementCount: 1,
      folderCount: 5,
      pendingLocationIntentCount: 2,
      lastWorkspaceBlocked: false,
    });
    const result = deleteWorkspacePreservingMeetings(input, {
      workspaceId: WORKSPACE_A,
      destinationWorkspaceId: WORKSPACE_B,
      records,
      pendingLocationIntentCount: 2,
    });
    expect(result.document.defaultWorkspaceId).toBe(WORKSPACE_B);
    expect(result.document.workspaces.map((workspace) => workspace.id)).toEqual([WORKSPACE_B]);
    expect(result.document.folders).toEqual([expect.objectContaining({ id: OTHER_FOLDER })]);
    expect(result.document.placements).toEqual([
      { meetingId: "visible", workspaceId: WORKSPACE_B, folderId: null },
      { meetingId: "hidden", workspaceId: WORKSPACE_B, folderId: null },
      { meetingId: "nested", workspaceId: WORKSPACE_B, folderId: null },
      { meetingId: "other", workspaceId: WORKSPACE_B, folderId: OTHER_FOLDER },
    ]);
    expect(input).toEqual(before);
  });

  it("blocks last-workspace, missing destination, and source=destination", () => {
    const single = {
      ...document(),
      defaultWorkspaceId: WORKSPACE_A,
      workspaces: document().workspaces.filter((workspace) => workspace.id === WORKSPACE_A),
      folders: document().folders.filter((candidate) => candidate.workspaceId === WORKSPACE_A),
      placements: document().placements.filter((placement) => placement.workspaceId === WORKSPACE_A),
    };
    expect(calculateWorkspaceDeleteImpact(single, {
      workspaceId: WORKSPACE_A,
      records,
      pendingLocationIntentCount: 0,
    }).lastWorkspaceBlocked).toBe(true);
    expect(() => deleteWorkspacePreservingMeetings(single, {
      workspaceId: WORKSPACE_A,
      destinationWorkspaceId: WORKSPACE_B,
      records,
      pendingLocationIntentCount: 0,
    })).toThrowError("last_workspace_delete");
    expect(() => deleteWorkspacePreservingMeetings(document(), {
      workspaceId: WORKSPACE_A,
      destinationWorkspaceId: WORKSPACE_A,
      records,
      pendingLocationIntentCount: 0,
    })).toThrowError("workspace_delete_destination_invalid");
  });
});
