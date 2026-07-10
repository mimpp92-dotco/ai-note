import { describe, expect, it } from "vitest";

import type { LibraryDocument } from "@/domain/library";
import {
  createFolder,
  createWorkspace,
  editFolder,
  moveMeetingPlacement,
  reparentFolder,
  renameWorkspace,
} from "@/domain/libraryMutations";

const LIBRARY_ID = "40000000-0000-4000-8000-000000000001";
const WORKSPACE_A = "40000000-0000-4000-8000-000000000002";
const WORKSPACE_B = "40000000-0000-4000-8000-000000000003";
const FOLDER_A = "40000000-0000-4000-8000-000000000004";
const FOLDER_B = "40000000-0000-4000-8000-000000000005";
const FOLDER_CHILD = "40000000-0000-4000-8000-000000000006";
const FOLDER_GRANDCHILD = "40000000-0000-4000-8000-000000000007";
const FOLDER_TARGET = "40000000-0000-4000-8000-000000000008";
const FOLDER_OTHER_WORKSPACE = "40000000-0000-4000-8000-000000000009";

function document(): LibraryDocument {
  return {
    schemaVersion: 1,
    libraryId: LIBRARY_ID,
    revision: 2,
    defaultWorkspaceId: WORKSPACE_A,
    workspaces: [{
      id: WORKSPACE_A,
      name: "기본",
      order: 0,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    }],
    folders: [{
      id: FOLDER_A,
      workspaceId: WORKSPACE_A,
      parentFolderId: null,
      name: "프로젝트",
      color: "brown",
      order: 0,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    }],
    placements: [],
  };
}

const NOW = "2026-07-10T01:00:00.000Z";

describe("library create/edit reducers", () => {
  it("appends a workspace and leaves the input untouched", () => {
    const input = document();
    const before = structuredClone(input);
    const next = createWorkspace(input, { id: WORKSPACE_B, name: " 새 공간 ", now: NOW });
    expect(next.workspaces.at(-1)).toMatchObject({
      id: WORKSPACE_B,
      name: "새 공간",
      order: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(input).toEqual(before);
  });

  it("renames a workspace while preserving identity/order/createdAt", () => {
    const next = renameWorkspace(document(), { workspaceId: WORKSPACE_A, name: "업무", now: NOW });
    expect(next.workspaces[0]).toEqual({
      ...document().workspaces[0],
      name: "업무",
      updatedAt: NOW,
    });
  });

  it("appends a folder to its sibling set and applies default color", () => {
    const next = createFolder(document(), {
      id: FOLDER_B,
      workspaceId: WORKSPACE_A,
      parentFolderId: null,
      name: "두 번째",
      now: NOW,
    });
    expect(next.folders.at(-1)).toMatchObject({
      id: FOLDER_B,
      parentFolderId: null,
      color: "brown",
      order: 1,
    });
  });

  it("edits only folder name/color and cannot reparent", () => {
    const next = editFolder(document(), {
      folderId: FOLDER_A,
      name: "변경",
      color: "sage",
      now: NOW,
    });
    expect(next.folders[0]).toMatchObject({
      name: "변경",
      color: "sage",
      workspaceId: WORKSPACE_A,
      parentFolderId: null,
      updatedAt: NOW,
    });
  });

  it("rolls back duplicate names, missing refs, depth overflow, and invalid color", () => {
    const input = document();
    expect(() => createWorkspace(input, { id: WORKSPACE_B, name: "  기본 ", now: NOW })).toThrow();
    expect(() => createFolder(input, {
      id: FOLDER_B,
      workspaceId: WORKSPACE_A,
      parentFolderId: null,
      name: "프로젝트",
      now: NOW,
    })).toThrow();
    expect(() => createFolder(input, {
      id: FOLDER_B,
      workspaceId: "40000000-0000-4000-8000-000000000099",
      parentFolderId: null,
      name: "없는 공간",
      now: NOW,
    })).toThrow();
    expect(() => editFolder(input, {
      folderId: FOLDER_A,
      color: "purple" as "brown",
      now: NOW,
    })).toThrow();
    expect(input).toEqual(document());
  });
});

function moveDocument(): LibraryDocument {
  const base = document();
  return {
    ...base,
    workspaces: [
      ...base.workspaces,
      {
        id: WORKSPACE_B,
        name: "개인",
        order: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    folders: [
      ...base.folders,
      {
        id: FOLDER_CHILD,
        workspaceId: WORKSPACE_A,
        parentFolderId: FOLDER_A,
        name: "하위",
        color: "sand",
        order: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: FOLDER_GRANDCHILD,
        workspaceId: WORKSPACE_A,
        parentFolderId: FOLDER_CHILD,
        name: "손자",
        color: "amber",
        order: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: FOLDER_TARGET,
        workspaceId: WORKSPACE_A,
        parentFolderId: null,
        name: "대상",
        color: "olive",
        order: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: FOLDER_OTHER_WORKSPACE,
        workspaceId: WORKSPACE_B,
        parentFolderId: null,
        name: "타 공간",
        color: "sage",
        order: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    placements: [{ meetingId: "meeting-1", workspaceId: WORKSPACE_A, folderId: FOLDER_A }],
  };
}

describe("library move reducers", () => {
  it("moves a meeting to same-workspace, cross-workspace, folder, and unfiled without touching input", () => {
    const input = moveDocument();
    const before = structuredClone(input);
    const sameWorkspace = moveMeetingPlacement(input, {
      meetingId: "meeting-1",
      workspaceId: WORKSPACE_A,
      folderId: FOLDER_TARGET,
    });
    expect(sameWorkspace.placements).toContainEqual({
      meetingId: "meeting-1",
      workspaceId: WORKSPACE_A,
      folderId: FOLDER_TARGET,
    });
    const crossWorkspace = moveMeetingPlacement(sameWorkspace, {
      meetingId: "meeting-1",
      workspaceId: WORKSPACE_B,
      folderId: FOLDER_OTHER_WORKSPACE,
    });
    expect(crossWorkspace.placements[0]).toMatchObject({
      workspaceId: WORKSPACE_B,
      folderId: FOLDER_OTHER_WORKSPACE,
    });
    expect(moveMeetingPlacement(crossWorkspace, {
      meetingId: "meeting-1",
      workspaceId: WORKSPACE_B,
      folderId: null,
    }).placements[0]).toMatchObject({ workspaceId: WORKSPACE_B, folderId: null });
    expect(input).toEqual(before);
  });

  it("keeps an exact meeting destination as a no-op and never falls back stale destinations", () => {
    const input = moveDocument();
    expect(moveMeetingPlacement(input, {
      meetingId: "meeting-1",
      workspaceId: WORKSPACE_A,
      folderId: FOLDER_A,
    })).toEqual(input);
    expect(() => moveMeetingPlacement(input, {
      meetingId: "meeting-1",
      workspaceId: "40000000-0000-4000-8000-000000000099",
      folderId: null,
    })).toThrowError("workspace_not_found");
    expect(() => moveMeetingPlacement(input, {
      meetingId: "meeting-1",
      workspaceId: WORKSPACE_A,
      folderId: FOLDER_OTHER_WORKSPACE,
    })).toThrowError("folder_not_found");
  });

  it("reparents a folder subtree at the target sibling tail and renormalizes both sibling sets", () => {
    const input = moveDocument();
    const before = structuredClone(input);
    const next = reparentFolder(input, {
      folderId: FOLDER_CHILD,
      parentFolderId: FOLDER_TARGET,
      now: "2026-07-10T02:00:00.000Z",
    });
    expect(next.folders.find((folder) => folder.id === FOLDER_CHILD)).toMatchObject({
      parentFolderId: FOLDER_TARGET,
      order: 0,
      updatedAt: "2026-07-10T02:00:00.000Z",
    });
    expect(next.folders.find((folder) => folder.id === FOLDER_GRANDCHILD)?.parentFolderId)
      .toBe(FOLDER_CHILD);
    expect(input).toEqual(before);
  });

  it("rejects self, descendant, current parent, cross-workspace, depth, and target name conflicts atomically", () => {
    const input = moveDocument();
    const before = structuredClone(input);
    expect(() => reparentFolder(input, {
      folderId: FOLDER_A,
      parentFolderId: FOLDER_A,
      now: NOW,
    })).toThrowError("folder_move_self");
    expect(() => reparentFolder(input, {
      folderId: FOLDER_A,
      parentFolderId: FOLDER_GRANDCHILD,
      now: NOW,
    })).toThrowError("folder_move_descendant");
    expect(() => reparentFolder(input, {
      folderId: FOLDER_CHILD,
      parentFolderId: FOLDER_A,
      now: NOW,
    })).toThrowError("folder_move_noop");
    expect(() => reparentFolder(input, {
      folderId: FOLDER_A,
      parentFolderId: FOLDER_OTHER_WORKSPACE,
      now: NOW,
    })).toThrowError("folder_move_cross_workspace");
    expect(() => reparentFolder(input, {
      folderId: FOLDER_TARGET,
      parentFolderId: FOLDER_GRANDCHILD,
      now: NOW,
    })).toThrowError("folder_move_depth");

    const conflicting: LibraryDocument = {
      ...input,
      folders: input.folders.map((folder) => folder.id === FOLDER_CHILD
        ? { ...folder, name: "대상" }
        : folder),
    };
    expect(() => reparentFolder(conflicting, {
      folderId: FOLDER_CHILD,
      parentFolderId: null,
      now: NOW,
    })).toThrowError("folder_name_conflict");
    expect(input).toEqual(before);
  });
});
