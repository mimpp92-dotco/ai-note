// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContainerDeleteDialog } from "@/components/ContainerDeleteDialog";
import type { LibraryProviderValue } from "@/components/LibraryProvider";

const LIBRARY_ID = "90000000-0000-4000-8000-000000000009";
const WORKSPACE_A = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "20000000-0000-4000-8000-000000000002";
const FOLDER = "30000000-0000-4000-8000-000000000003";
const PARENT = "30000000-0000-4000-8000-000000000004";
const VERSION = { libraryId: LIBRARY_ID, revision: 8 };
const timestamp = "2026-07-10T00:00:00.000Z";
let libraryState: LibraryProviderValue;

vi.mock("@/components/LibraryProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/LibraryProvider")>();
  return { ...actual, useLibrary: () => libraryState };
});

function state(): LibraryProviderValue {
  return {
    mode: "ready",
    version: VERSION,
    recovery: null,
    library: {
      defaultWorkspaceId: WORKSPACE_A,
      workspaces: [
        { id: WORKSPACE_A, name: "업무", order: 0, createdAt: timestamp, updatedAt: timestamp },
        { id: WORKSPACE_B, name: "개인", order: 1, createdAt: timestamp, updatedAt: timestamp },
      ],
      folders: [
        { id: PARENT, workspaceId: WORKSPACE_A, parentFolderId: null, name: "상위", color: "brown", order: 0, createdAt: timestamp, updatedAt: timestamp },
        { id: FOLDER, workspaceId: WORKSPACE_A, parentFolderId: PARENT, name: "정리 대상", color: "sage", order: 0, createdAt: timestamp, updatedAt: timestamp },
      ],
      counts: { visibleMeetingCount: 2, hiddenInvalidStatusCount: 1, organizationPendingCount: 0, workspaces: [], folders: [] },
    },
    scope: { kind: "folder", workspaceId: WORKSPACE_A, folderId: FOLDER },
    pages: { versionKey: `${LIBRARY_ID}:8`, scopeKey: `folder:${WORKSPACE_A}:${FOLDER}`, currentPosition: 0, pages: new Map(), entities: new Map(), cursorHistory: new Map() },
    expandedFolderIds: new Set(),
    summaryWork: null,
    organizationPending: null,
    generationResult: null,
    generationEpoch: 0,
    setScope: vi.fn(),
    setCurrentPage: vi.fn(),
    loadPage: vi.fn(),
    toggleFolder: vi.fn(),
    refreshLibrary: vi.fn(),
    refreshSummaryWork: vi.fn(),
    refreshOrganizationPending: vi.fn(),
    runLibraryMutation: vi.fn(),
    invalidateStatusWork: vi.fn(),
    invalidateOrganizationPending: vi.fn(),
    updateMeetingTitle: vi.fn(),
    removeMeeting: vi.fn(),
    resetForGeneration: vi.fn(),
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function dispatchNativeCancel(dialog: HTMLElement) {
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
}

const folderImpact = {
  kind: "folder",
  folderId: FOLDER,
  workspaceId: WORKSPACE_A,
  directVisibleMeetingCount: 1,
  affectedPlacementCount: 2,
  hiddenInvalidStatusPlacementCount: 1,
  pendingLocationIntentCount: 3,
  directChildFolderCount: 2,
  target: { workspaceId: WORKSPACE_A, folderId: PARENT },
  promotionConflicts: [],
  artifactPolicy: "meeting_artifacts_preserved",
};

describe("ContainerDeleteDialog", () => {
  beforeEach(() => {
    libraryState = state();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("shows honest folder impact, focuses cancel, and commits with the preview token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      mode: "ready",
      version: VERSION,
      library: libraryState.library,
      impact: folderImpact,
    })));
    const committed = {
      mode: "ready" as const,
      version: { ...VERSION, revision: 9 },
      library: libraryState.library,
      impact: folderImpact,
      redirect: folderImpact.target,
    };
    libraryState.runLibraryMutation = vi.fn(async () => ({
      response: response(committed),
      payload: committed,
      accepted: true,
    }));
    const onDeleted = vi.fn();
    render(<ContainerDeleteDialog
      kind="folder"
      container={{ id: FOLDER, name: "정리 대상" }}
      trigger={null}
      onClose={vi.fn()}
      onDeleted={onDeleted}
    />);
    expect(screen.getByRole("button", { name: "취소" })).toHaveFocus();
    await screen.findByText(/회의 1개를 .*상위로 이동/);
    expect(screen.getByText(/영향받는 배치 2개.*숨겨진 잘못된 상태 1개/)).toBeInTheDocument();
    expect(screen.getByText(/저장 대기 위치 요청 3개/)).toBeInTheDocument();
    expect(screen.getByText(/회의 원본과 전사·요약 파일은 삭제하지 않습니다/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "폴더만 삭제하고 보존" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(committed));
    const [url, init] = vi.mocked(libraryState.runLibraryMutation).mock.calls[0];
    expect(url).toBe(`/api/folders/${FOLDER}`);
    expect(JSON.parse(String(init.body))).toEqual({
      expectedLibraryId: VERSION.libraryId,
      expectedRevision: VERSION.revision,
    });
  });

  it("blocks a folder promotion conflict without attempting partial deletion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      mode: "ready",
      version: VERSION,
      library: libraryState.library,
      impact: {
        ...folderImpact,
        promotionConflicts: [{ promotedFolderId: "child", existingFolderId: "existing", targetParentFolderId: PARENT }],
      },
    })));
    render(<ContainerDeleteDialog
      kind="folder"
      container={{ id: FOLDER, name: "정리 대상" }}
      trigger={null}
      onClose={vi.fn()}
      onDeleted={vi.fn()}
    />);
    expect(await screen.findByText(/같은 이름의 폴더를 먼저 이름 변경하거나 이동/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "폴더만 삭제하고 보존" })).toBeDisabled();
    expect(libraryState.runLibraryMutation).not.toHaveBeenCalled();
  });

  it("requires destination and exact workspace name; Korean IME Enter never confirms early", async () => {
    const impact = {
      kind: "workspace",
      workspaceId: WORKSPACE_A,
      visibleMeetingCount: 2,
      affectedPlacementCount: 2,
      hiddenInvalidStatusPlacementCount: 0,
      folderCount: 1,
      pendingLocationIntentCount: 0,
      destinationCandidates: [{ id: WORKSPACE_B, name: "개인" }],
      lastWorkspaceBlocked: false,
      blockedReason: null,
      artifactPolicy: "meeting_artifacts_preserved",
    };
    vi.stubGlobal("fetch", vi.fn(async () => response({ mode: "ready", version: VERSION, library: libraryState.library, impact })));
    const committed = { mode: "ready" as const, version: { ...VERSION, revision: 9 }, library: libraryState.library, impact, redirect: { workspaceId: WORKSPACE_B, folderId: null } };
    libraryState.runLibraryMutation = vi.fn(async () => ({
      response: response(committed),
      payload: committed,
      accepted: true,
    }));
    render(<ContainerDeleteDialog
      kind="workspace"
      container={{ id: WORKSPACE_A, name: "업무" }}
      trigger={null}
      onClose={vi.fn()}
      onDeleted={vi.fn()}
    />);
    await screen.findByText(/회의 2개를 선택한 워크스페이스의 미분류로 이동/);
    fireEvent.change(screen.getByRole("combobox", { name: "보존할 워크스페이스" }), { target: { value: WORKSPACE_B } });
    const confirmation = screen.getByRole("textbox", { name: "워크스페이스 이름 확인" });
    fireEvent.compositionStart(confirmation);
    fireEvent.change(confirmation, { target: { value: "업무" } });
    fireEvent.keyDown(confirmation, { key: "Enter", keyCode: 229, isComposing: true });
    expect(libraryState.runLibraryMutation).not.toHaveBeenCalled();
    fireEvent.compositionEnd(confirmation);
    fireEvent.click(screen.getByRole("button", { name: "워크스페이스만 삭제하고 보존" }));
    await waitFor(() => expect(libraryState.runLibraryMutation).toHaveBeenCalledTimes(1));
  });

  it("disables the last workspace action with an inline reason", async () => {
    libraryState = {
      ...state(),
      library: {
        ...state().library!,
        workspaces: [state().library!.workspaces[0]],
      },
    };
    const impact = {
      kind: "workspace",
      workspaceId: WORKSPACE_A,
      visibleMeetingCount: 0,
      affectedPlacementCount: 0,
      hiddenInvalidStatusPlacementCount: 0,
      folderCount: 0,
      pendingLocationIntentCount: 0,
      destinationCandidates: [],
      lastWorkspaceBlocked: true,
      blockedReason: "last_workspace",
      artifactPolicy: "meeting_artifacts_preserved",
    };
    vi.stubGlobal("fetch", vi.fn(async () => response({ mode: "ready", version: VERSION, library: libraryState.library, impact })));
    render(<ContainerDeleteDialog
      kind="workspace"
      container={{ id: WORKSPACE_A, name: "업무" }}
      trigger={null}
      onClose={vi.fn()}
      onDeleted={vi.fn()}
    />);
    expect(await screen.findByText("마지막 워크스페이스는 삭제할 수 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "워크스페이스만 삭제하고 보존" })).toBeDisabled();
  });

  it("keeps a delete dialog open while its mutation is in flight", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      mode: "ready",
      version: VERSION,
      library: libraryState.library,
      impact: folderImpact,
    })));
    let finishMutation!: (value: Awaited<ReturnType<LibraryProviderValue["runLibraryMutation"]>>) => void;
    libraryState.runLibraryMutation = vi.fn(() => new Promise<Awaited<ReturnType<LibraryProviderValue["runLibraryMutation"]>>>((resolve) => { finishMutation = resolve; }));
    const onClose = vi.fn();
    render(<ContainerDeleteDialog
      kind="folder"
      container={{ id: FOLDER, name: "정리 대상" }}
      trigger={null}
      onClose={onClose}
      onDeleted={vi.fn()}
    />);
    await screen.findByText(/회의 1개를 .*상위로 이동/);
    fireEvent.click(screen.getByRole("button", { name: "폴더만 삭제하고 보존" }));
    await screen.findByRole("button", { name: "보존하며 삭제 중…" });
    const dialog = screen.getByRole("dialog", { name: "폴더 삭제 후 보존" });
    const cancel = screen.getByRole("button", { name: "취소" });
    expect(cancel).toBeDisabled();
    dispatchNativeCancel(dialog);
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    fireEvent.click(cancel);
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();

    finishMutation({
      response: response({ error: { code: "delete_failed" } }, 500),
      payload: null,
      accepted: true,
    });
    await waitFor(() => expect(screen.getByText(/삭제하지 못했습니다/)).toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "폴더 삭제 후 보존" })).toBeInTheDocument();
  });
});
