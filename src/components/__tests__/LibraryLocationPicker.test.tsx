// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LibraryLocationPicker } from "@/components/LibraryLocationPicker";
import type { LibraryProviderValue } from "@/components/LibraryProvider";

const WORKSPACE_A = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "20000000-0000-4000-8000-000000000002";
const ROOT_A = "30000000-0000-4000-8000-000000000003";
const CHILD_A = "30000000-0000-4000-8000-000000000004";
const OTHER_FOLDER = "30000000-0000-4000-8000-000000000007";
const VERSION = { libraryId: "90000000-0000-4000-8000-000000000009", revision: 4 };
const timestamp = "2026-07-10T00:00:00.000Z";

let libraryState: LibraryProviderValue;

vi.mock("@/components/LibraryProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/LibraryProvider")>();
  return { ...actual, useLibrary: () => libraryState };
});

function state(overrides: Partial<LibraryProviderValue> = {}): LibraryProviderValue {
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
        { id: ROOT_A, workspaceId: WORKSPACE_A, parentFolderId: null, name: "고객 A", color: "brown", order: 0, createdAt: timestamp, updatedAt: timestamp },
        { id: CHILD_A, workspaceId: WORKSPACE_A, parentFolderId: ROOT_A, name: "회의", color: "sand", order: 0, createdAt: timestamp, updatedAt: timestamp },
        { id: OTHER_FOLDER, workspaceId: WORKSPACE_B, parentFolderId: null, name: "개인 기록", color: "sage", order: 0, createdAt: timestamp, updatedAt: timestamp },
      ],
      counts: {
        visibleMeetingCount: 1,
        hiddenInvalidStatusCount: 0,
        organizationPendingCount: 0,
        workspaces: [],
        folders: [],
      },
    },
    scope: { kind: "folder", workspaceId: WORKSPACE_A, folderId: CHILD_A },
    pages: {
      versionKey: `${VERSION.libraryId}:${VERSION.revision}`,
      scopeKey: `folder:${WORKSPACE_A}:${CHILD_A}`,
      currentPosition: 0,
      pages: new Map(),
      entities: new Map(),
      cursorHistory: new Map(),
    },
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
    ...overrides,
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("LibraryLocationPicker", () => {
  beforeEach(() => {
    libraryState = state();
  });

  it("moves a meeting across workspaces with an explicit source/destination summary", async () => {
    const onMoved = vi.fn();
    const payload = {
      mode: "ready" as const,
      version: { ...VERSION, revision: 5 },
      library: libraryState.library,
      location: { workspaceId: WORKSPACE_B, folderId: OTHER_FOLDER, breadcrumb: ["개인 기록"] },
    };
    libraryState.runLibraryMutation = vi.fn(async () => ({
      response: response(payload),
      payload,
      accepted: true,
    }));
    render(<LibraryLocationPicker
      kind="meeting"
      meetingId="meeting-1"
      current={{ workspaceId: WORKSPACE_A, folderId: CHILD_A }}
      trigger={null}
      onClose={vi.fn()}
      onMoved={onMoved}
    />);
    fireEvent.change(screen.getByRole("combobox", { name: "이동할 워크스페이스" }), {
      target: { value: WORKSPACE_B },
    });
    fireEvent.change(screen.getByRole("searchbox", { name: "폴더 검색" }), {
      target: { value: "개인 기록" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /개인 \/ 개인 기록/ }));
    expect(screen.getByText(/업무 \/ 고객 A \/ 회의 → 개인 \/ 개인 기록/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "이 위치로 이동" }));
    await waitFor(() => expect(onMoved).toHaveBeenCalledWith(payload.location));
    const [url, init] = vi.mocked(libraryState.runLibraryMutation).mock.calls[0];
    expect(url).toBe("/api/meetings/meeting-1/location");
    expect(JSON.parse(String(init.body))).toMatchObject({
      expectedLibraryId: VERSION.libraryId,
      expectedRevision: VERSION.revision,
      workspaceId: WORKSPACE_B,
      folderId: OTHER_FOLDER,
    });
  });

  it("clears a stale selection after an authoritative 409 instead of choosing a fallback", async () => {
    libraryState.runLibraryMutation = vi.fn(async () => ({
      response: response({ error: { code: "library_destination_conflict" } }, 409),
      payload: null,
      accepted: true,
    }));
    render(<LibraryLocationPicker
      kind="meeting"
      meetingId="meeting-1"
      current={{ workspaceId: WORKSPACE_A, folderId: CHILD_A }}
      trigger={null}
      onClose={vi.fn()}
      onMoved={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("radio", { name: /업무 \/ 미분류/ }));
    fireEvent.click(screen.getByRole("button", { name: "이 위치로 이동" }));
    await waitFor(() => expect(screen.getByText(/최신 위치를 다시 선택/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "이 위치로 이동" })).toBeDisabled();
  });

  it("limits folder moves to one workspace and explains the v1 boundary", () => {
    render(<LibraryLocationPicker
      kind="folder"
      folderId={CHILD_A}
      trigger={null}
      onClose={vi.fn()}
      onMoved={vi.fn()}
    />);
    expect(screen.getByText(/다른 워크스페이스로 폴더 이동은 지원하지 않습니다/)).toBeInTheDocument();
    expect(screen.queryByText(/개인 기록/)).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /업무 \/ 고객 A/ })).toBeDisabled();
  });

  it("submits folder reparent intent separately from name/color editing", async () => {
    const payload = {
      mode: "ready" as const,
      version: { ...VERSION, revision: 5 },
      library: libraryState.library,
    };
    libraryState.runLibraryMutation = vi.fn(async () => ({
      response: response(payload),
      payload,
      accepted: true,
    }));
    const onMoved = vi.fn();
    render(<LibraryLocationPicker
      kind="folder"
      folderId={CHILD_A}
      trigger={null}
      onClose={vi.fn()}
      onMoved={onMoved}
    />);
    fireEvent.click(screen.getByRole("radio", { name: /업무 \/ 최상위/ }));
    fireEvent.click(screen.getByRole("button", { name: "이 위치로 이동" }));
    await waitFor(() => expect(onMoved).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_A,
      folderId: null,
    }));
    const [url, init] = vi.mocked(libraryState.runLibraryMutation).mock.calls[0];
    expect(url).toBe(`/api/folders/${CHILD_A}/parent`);
    expect(JSON.parse(String(init.body))).toEqual({
      expectedLibraryId: VERSION.libraryId,
      expectedRevision: VERSION.revision,
      parentFolderId: null,
    });
  });
});
