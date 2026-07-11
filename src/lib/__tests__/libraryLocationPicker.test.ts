import { describe, expect, it } from "vitest";

import type { PublicLibraryView } from "@/lib/libraryQuery";
import {
  buildFolderParentOptions,
  buildMeetingLocationOptions,
  filterLocationOptions,
} from "@/lib/libraryLocationPicker";

const WORKSPACE_A = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "20000000-0000-4000-8000-000000000002";
const ROOT_A = "30000000-0000-4000-8000-000000000003";
const CHILD_A = "30000000-0000-4000-8000-000000000004";
const ROOT_DUPLICATE = "30000000-0000-4000-8000-000000000005";
const CHILD_DUPLICATE = "30000000-0000-4000-8000-000000000006";
const OTHER_FOLDER = "30000000-0000-4000-8000-000000000007";

const timestamp = "2026-07-10T00:00:00.000Z";
const library: PublicLibraryView = {
  defaultWorkspaceId: WORKSPACE_A,
  workspaces: [
    { id: WORKSPACE_A, name: "업무", order: 0, createdAt: timestamp, updatedAt: timestamp },
    { id: WORKSPACE_B, name: "개인", order: 1, createdAt: timestamp, updatedAt: timestamp },
  ],
  folders: [
    { id: ROOT_A, workspaceId: WORKSPACE_A, parentFolderId: null, name: "고객 A", color: "brown", order: 0, createdAt: timestamp, updatedAt: timestamp },
    { id: CHILD_A, workspaceId: WORKSPACE_A, parentFolderId: ROOT_A, name: "회의", color: "sand", order: 0, createdAt: timestamp, updatedAt: timestamp },
    { id: ROOT_DUPLICATE, workspaceId: WORKSPACE_A, parentFolderId: null, name: "고객 B", color: "amber", order: 1, createdAt: timestamp, updatedAt: timestamp },
    { id: CHILD_DUPLICATE, workspaceId: WORKSPACE_A, parentFolderId: ROOT_DUPLICATE, name: "회의", color: "olive", order: 0, createdAt: timestamp, updatedAt: timestamp },
    { id: OTHER_FOLDER, workspaceId: WORKSPACE_B, parentFolderId: null, name: "개인 기록", color: "sage", order: 0, createdAt: timestamp, updatedAt: timestamp },
  ],
  counts: {
    visibleMeetingCount: 0,
    hiddenInvalidStatusCount: 0,
    organizationPendingCount: 0,
    workspaces: [],
    folders: [],
  },
};

describe("library location picker model", () => {
  it("builds cross-workspace meeting destinations and distinguishes duplicate leaves by ancestors", () => {
    const options = buildMeetingLocationOptions(library, {
      workspaceId: WORKSPACE_A,
      folderId: CHILD_A,
    });
    expect(options.find((option) => option.folderId === CHILD_A)).toMatchObject({
      label: "업무 / 고객 A / 회의",
      disabledReason: "현재 위치",
    });
    expect(options.find((option) => option.folderId === CHILD_DUPLICATE)?.label)
      .toBe("업무 / 고객 B / 회의");
    expect(options).toContainEqual(expect.objectContaining({
      workspaceId: WORKSPACE_B,
      folderId: null,
      label: "개인 / 미분류",
    }));
  });

  it("normalizes search across workspace and ancestor breadcrumb text", () => {
    const options = buildMeetingLocationOptions(library, null);
    expect(filterLocationOptions(options, "  고객   b ").map((option) => option.folderId))
      .toEqual([ROOT_DUPLICATE, CHILD_DUPLICATE]);
    expect(filterLocationOptions(options, "개인 기록").map((option) => option.folderId))
      .toEqual([OTHER_FOLDER]);
  });

  it("restricts folder parents to the same workspace and explains current/descendant/depth choices", () => {
    const options = buildFolderParentOptions(library, CHILD_A);
    expect(options.some((option) => option.workspaceId === WORKSPACE_B)).toBe(false);
    expect(options.find((option) => option.folderId === ROOT_A)?.disabledReason).toBe("현재 위치");
    expect(options.some((option) => option.folderId === CHILD_A)).toBe(false);

    const rootOptions = buildFolderParentOptions(library, ROOT_A);
    expect(rootOptions.some((option) => option.folderId === CHILD_A)).toBe(false);
    expect(rootOptions.find((option) => option.folderId === CHILD_DUPLICATE)?.disabledReason)
      .toBe("이동하면 최대 3단계를 넘습니다");
    expect(rootOptions.every((option) => option.label.startsWith("업무 /"))).toBe(true);
  });
});
