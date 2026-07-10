// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HomeClient } from "@/components/HomeClient";
import { LibraryNavigation } from "@/components/LibraryNavigation";
import { MeetingDetailView } from "@/components/MeetingDetailView";
import { RecorderSessionProvider } from "@/components/RecorderSessionProvider";
import type { LibraryProviderValue } from "@/components/LibraryProvider";
import type { StatusJson } from "@/domain/meeting";

const navigation = vi.hoisted(() => ({
  pathname: "/",
  search: "workspace=10000000-0000-4000-8000-000000000001",
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
}));

let libraryState: LibraryProviderValue;

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: {
    href: string;
    children: import("react").ReactNode;
  }) => <a href={href} {...props}>{children}</a>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => navigation,
}));

vi.mock("@/components/LibraryProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/LibraryProvider")>();
  return {
    ...actual,
    useLibrary: () => libraryState,
    useOptionalLibrary: () => libraryState,
  };
});

vi.mock("@/components/useHealth", () => ({
  useHealth: () => ({
    whisper: { connected: true, ready: true, model: "base" },
    llm: { configured: true, provider: "claude-cli", model: "sonnet", ok: true, detail: "ready" },
  }),
}));

const VERSION = { libraryId: "90000000-0000-4000-8000-000000000009", revision: 3 };
const DEFAULT_WORKSPACE = "10000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE = "20000000-0000-4000-8000-000000000002";
const FOLDER = "30000000-0000-4000-8000-000000000003";

function detailStatus(): StatusJson {
  return {
    id: "meeting-1",
    title: "제품 회의",
    status: "summarized",
    error: null,
    startedAt: "2026-07-10T00:00:00.000Z",
    endedAt: "2026-07-10T01:00:00.000Z",
    durationMs: 3_600_000,
    audioMime: "audio/webm",
    whisper: { jobId: null, progress: 1 },
    paths: { audio: "", play: "", raw: "", transcript: "", summary: "", segments: "" },
    review: { participants: [] },
    updatedAt: "2026-07-10T01:00:00.000Z",
  };
}

function readyState(overrides: Partial<LibraryProviderValue> = {}): LibraryProviderValue {
  const row = {
    id: "meeting-1",
    title: "제품 회의",
    status: "summarized" as const,
    startedAt: "2026-07-10T00:00:00.000Z",
    error: null,
    location: { workspaceId: DEFAULT_WORKSPACE, folderId: FOLDER, breadcrumb: ["프로젝트"] },
  };
  return {
    mode: "ready",
    version: VERSION,
    recovery: null,
    library: {
      defaultWorkspaceId: DEFAULT_WORKSPACE,
      workspaces: [
        { id: DEFAULT_WORKSPACE, name: "기본", order: 0, createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" },
        { id: OTHER_WORKSPACE, name: "업무", order: 1, createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" },
      ],
      folders: [{
        id: FOLDER,
        workspaceId: DEFAULT_WORKSPACE,
        parentFolderId: null,
        name: "프로젝트",
        color: "sage",
        order: 0,
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z",
      }],
      counts: {
        visibleMeetingCount: 1,
        hiddenInvalidStatusCount: 0,
        organizationPendingCount: 1,
        workspaces: [
          { workspaceId: DEFAULT_WORKSPACE, total: 1, unfiled: 0 },
          { workspaceId: OTHER_WORKSPACE, total: 0, unfiled: 0 },
        ],
        folders: [{ folderId: FOLDER, direct: 1 }],
      },
    },
    scope: { kind: "workspace", workspaceId: DEFAULT_WORKSPACE },
    pages: {
      versionKey: `${VERSION.libraryId}:${VERSION.revision}`,
      scopeKey: `workspace:${DEFAULT_WORKSPACE}`,
      currentPosition: 0,
      pages: new Map([[0, { position: 0, cursor: null, nextCursor: null, ids: [row.id], loadedAt: Date.now() }]]),
      entities: new Map([[row.id, row]]),
      cursorHistory: new Map([[0, null]]),
    },
    expandedFolderIds: new Set([FOLDER]),
    summaryWork: {
      summaryWork: {
        processing: 0,
        needsAttention: 2,
        attention: { meetingId: "attention-1", cursor: "attention-cursor" },
      },
      observedAt: "2026-07-10T00:00:00.000Z",
    },
    organizationPending: {
      count: 1,
      rows: [{
        id: "pending-1",
        title: "위치 대기 회의",
        status: "recorded",
        startedAt: "2026-07-10T01:00:00.000Z",
        error: null,
        organizationPending: true,
        resolution: "unavailable",
        requested: { workspaceId: DEFAULT_WORKSPACE, folderId: null },
        locationSource: "explicit",
        actual: null,
        action: "detail_probe",
      }],
      nextCursor: null,
      observedAt: "2026-07-10T00:00:00.000Z",
      sequence: "0".repeat(64),
      version: VERSION,
    },
    generationResult: null,
    generationEpoch: 0,
    setScope: vi.fn(),
    setCurrentPage: vi.fn(),
    loadPage: vi.fn(async () => {}),
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

function renderShell() {
  return render(
    <RecorderSessionProvider>
      <div id="app-content">
        <LibraryNavigation />
        <HomeClient />
      </div>
    </RecorderSessionProvider>,
  );
}

describe("activated library navigation", () => {
  beforeEach(() => {
    navigation.pathname = "/";
    navigation.search = `workspace=${DEFAULT_WORKSPACE}`;
    navigation.push.mockReset();
    navigation.replace.mockReset();
    navigation.refresh.mockReset();
    libraryState = readyState();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders workspace/all/unfiled/folder navigation with Phase 15 move actions but no delete/rebuild", () => {
    renderShell();
    const nav = screen.getByRole("navigation", { name: "라이브러리" });
    expect(nav).toHaveTextContent("기본");
    expect(nav).toHaveTextContent("모든 회의");
    expect(nav).toHaveTextContent("미분류");
    expect(nav).toHaveTextContent("프로젝트");
    expect(screen.getByRole("button", { name: "새 워크스페이스" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "프로젝트 폴더 편집" })).toBeInTheDocument();
    expect(screen.queryByText(/삭제|재구성/)).not.toBeInTheDocument();
  });

  it("uses global summary work, source-safe row links, pending provisional rows, and default-All recorder", () => {
    renderShell();
    expect(screen.getByText("2개 확인 필요")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "확인할 회의 열기" }))
      .toHaveAttribute("href", "/meetings/attention-1?attentionAfter=attention-cursor");
    expect(screen.getByRole("link", { name: /제품 회의/ }).getAttribute("href")).toContain(
      `sourceWorkspace=${DEFAULT_WORKSPACE}`,
    );
    expect(screen.getByText("조직 정보 없이 발견된 회의")).toBeInTheDocument();
    expect(screen.getByText("위치 저장 안 됨")).toBeInTheDocument();
    expect(screen.getByText(/요청 위치: 기본 · 미분류/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "실시간 기록 시작" })).toBeInTheDocument();
    expect(screen.getByText(/이 워크스페이스의 미분류에 저장/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "위치 선택" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "제품 회의 관리 메뉴" }));
    expect(screen.getByRole("button", { name: "이동" })).toBeInTheDocument();
  });

  it("opens the shared same-workspace folder move picker", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 폴더 편집" }));
    fireEvent.click(screen.getByRole("button", { name: "폴더 이동" }));
    expect(screen.getByRole("dialog", { name: "폴더 이동" })).toBeInTheDocument();
    expect(screen.getByText(/다른 워크스페이스로 폴더 이동은 지원하지 않습니다/)).toBeInTheDocument();
  });

  it("canonicalizes a deleted current root folder to unfiled while preserving meetings", async () => {
    navigation.search = `workspace=${DEFAULT_WORKSPACE}&folder=${FOLDER}`;
    const impact = {
      kind: "folder" as const,
      folderId: FOLDER,
      workspaceId: DEFAULT_WORKSPACE,
      directVisibleMeetingCount: 1,
      affectedPlacementCount: 1,
      hiddenInvalidStatusPlacementCount: 0,
      pendingLocationIntentCount: 0,
      directChildFolderCount: 0,
      target: { workspaceId: DEFAULT_WORKSPACE, folderId: null },
      promotionConflicts: [],
      artifactPolicy: "meeting_artifacts_preserved" as const,
    };
    const before = readyState({ scope: { kind: "folder", workspaceId: DEFAULT_WORKSPACE, folderId: FOLDER } });
    const nextLibrary = before.library
      ? { ...before.library, folders: before.library.folders.filter((folder) => folder.id !== FOLDER) }
      : null;
    const committed = {
      mode: "ready" as const,
      version: { ...VERSION, revision: VERSION.revision + 1 },
      library: nextLibrary,
      impact,
      redirect: impact.target,
    };
    libraryState = readyState({
      scope: { kind: "folder", workspaceId: DEFAULT_WORKSPACE, folderId: FOLDER },
      runLibraryMutation: vi.fn(async () => ({
        response: new Response(JSON.stringify(committed), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        payload: committed,
        accepted: true,
      })),
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      mode: "ready",
      version: VERSION,
      library: libraryState.library,
      impact,
    }), { status: 200, headers: { "content-type": "application/json" } })));
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 폴더 편집" }));
    fireEvent.click(screen.getByRole("button", { name: "폴더 삭제 후 보존" }));
    await screen.findByText(/회의 원본과 전사·요약 파일은 삭제하지 않습니다/);
    fireEvent.click(screen.getByRole("button", { name: "폴더만 삭제하고 보존" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith(
      `/?workspace=${DEFAULT_WORKSPACE}&view=unfiled`,
    ));
  });

  it("updates a detail source to the authoritative cross-workspace destination after move", async () => {
    navigation.pathname = "/meetings/meeting-1";
    navigation.search = `sourceWorkspace=${DEFAULT_WORKSPACE}&sourceView=folder&sourceFolder=${FOLDER}`;
    const payload = {
      mode: "ready" as const,
      version: { ...VERSION, revision: VERSION.revision + 1 },
      library: readyState().library,
      location: { workspaceId: OTHER_WORKSPACE, folderId: null, breadcrumb: [] },
    };
    libraryState = readyState({
      runLibraryMutation: vi.fn(async () => ({
        response: new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        payload,
        accepted: true,
      })),
    });
    render(
      <RecorderSessionProvider>
        <MeetingDetailView
          id="meeting-1"
          status={detailStatus()}
          transcript={{ text: "본문", corrected: true }}
          segments={[]}
          summary={null}
          hasAudio={false}
          location={{ workspaceId: DEFAULT_WORKSPACE, folderId: FOLDER }}
          source={{ kind: "folder", workspaceId: DEFAULT_WORKSPACE, folderId: FOLDER }}
        />
      </RecorderSessionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "회의 이동" }));
    fireEvent.change(screen.getByRole("combobox", { name: "이동할 워크스페이스" }), {
      target: { value: OTHER_WORKSPACE },
    });
    fireEvent.click(screen.getByRole("radio", { name: /업무 \/ 미분류/ }));
    fireEvent.click(screen.getByRole("button", { name: "이 위치로 이동" }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith(
      `/meetings/meeting-1?sourceWorkspace=${OTHER_WORKSPACE}&sourceView=unfiled`,
    ));
    expect(screen.getByText(/목록 기준도 실제 저장 위치로 바꿨습니다/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← 목록" }))
      .toHaveAttribute("href", `/?workspace=${OTHER_WORKSPACE}&view=unfiled`);
  });

  it("opens recording in another ready scope with an immutable unfiled destination", () => {
    navigation.search = `workspace=${OTHER_WORKSPACE}`;
    libraryState = readyState({ scope: { kind: "workspace", workspaceId: OTHER_WORKSPACE } });
    renderShell();
    expect(screen.getByRole("button", { name: "실시간 기록 시작" })).toBeInTheDocument();
    expect(screen.getByText(/이 워크스페이스의 미분류에 저장/)).toBeInTheDocument();
  });

  it("keeps last-good navigation read-only and exposes corrupt-only rebuild", () => {
    libraryState = readyState({
      mode: "degraded_last_good",
      version: null,
      degradedReason: "corrupt",
      recovery: { canRebuild: true, fingerprint: "a".repeat(64) },
    });
    renderShell();
    expect(screen.getByText(/조직 정보를 읽는 데 문제가 있습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "새 워크스페이스" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "데이터 폴더 열기" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "조직 정보 재구축" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "실시간 기록 시작" })).toBeInTheDocument();
    expect(screen.getByText(/마지막으로 확인된 위치를 요청/)).toBeInTheDocument();
  });

  it("refreshes an open detail when a new library generation replaces its source IDs", async () => {
    const detail = () => (
      <RecorderSessionProvider>
        <MeetingDetailView
          id="meeting-1"
          status={detailStatus()}
          transcript={{ text: "본문", corrected: true }}
          segments={[]}
          summary={null}
          hasAudio={false}
          location={{ workspaceId: DEFAULT_WORKSPACE, folderId: FOLDER }}
          source={{ kind: "folder", workspaceId: DEFAULT_WORKSPACE, folderId: FOLDER }}
        />
      </RecorderSessionProvider>
    );
    const view = render(detail());
    fireEvent.click(screen.getByRole("button", { name: "회의 이동" }));
    expect(screen.getByRole("dialog", { name: "회의 이동" })).toBeInTheDocument();
    libraryState = readyState({
      version: { libraryId: "80000000-0000-4000-8000-000000000008", revision: 0 },
      generationEpoch: 1,
    });
    view.rerender(detail());
    await waitFor(() => expect(navigation.refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "회의 이동" })).not.toBeInTheDocument();
  });

  it("replaces stale detail source IDs with the server-resolved canonical source", async () => {
    navigation.pathname = "/meetings/meeting-1";
    navigation.search = `sourceWorkspace=${DEFAULT_WORKSPACE}&sourceView=folder&sourceFolder=70000000-0000-4000-8000-000000000007&attentionAfter=cursor`;
    libraryState = readyState();
    const canonical = `/meetings/meeting-1?sourceWorkspace=${OTHER_WORKSPACE}&sourceView=all&attentionAfter=cursor`;
    render(
      <RecorderSessionProvider>
        <LibraryNavigation />
        <MeetingDetailView
          id="meeting-1"
          status={detailStatus()}
          transcript={{ text: "본문", corrected: true }}
          segments={[]}
          summary={null}
          hasAudio={false}
          backHref={`/?workspace=${OTHER_WORKSPACE}`}
          location={{ workspaceId: OTHER_WORKSPACE, folderId: null }}
          source={{ kind: "workspace", workspaceId: OTHER_WORKSPACE }}
          sourceAccepted={false}
          canonicalDetailHref={canonical}
          attentionAfter="cursor"
        />
      </RecorderSessionProvider>,
    );
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith(canonical));
    expect(screen.getByRole("link", { name: "← 목록" }))
      .toHaveAttribute("href", `/?workspace=${OTHER_WORKSPACE}`);
    expect(screen.getByRole("navigation", { name: "라이브러리" }))
      .not.toHaveTextContent("70000000-0000-4000-8000-000000000007");
  });

  it("shows a path-free rebuild result after the new generation loads", () => {
    libraryState = readyState({
      generationResult: {
        discoveredVisibleMeetingCount: 7,
        organizationReset: true,
        archivePreserved: true,
      },
    });
    renderShell();
    const result = screen.getByText("조직 정보 재구축 완료").closest("section");
    expect(result).not.toBeNull();
    expect(result).toHaveTextContent("조직 정보 재구축 완료");
    expect(result).toHaveTextContent("발견한 회의 7개");
    expect(result).toHaveTextContent("로컬 보관본으로 보존");
    expect(result).not.toHaveTextContent(/library-recovery|library\.archive|\/tmp/);
  });

  it("closes organization forms as soon as a generation reset starts", async () => {
    const view = renderShell();
    fireEvent.click(screen.getByRole("button", { name: "새 워크스페이스" }));
    expect(screen.getByRole("dialog", { name: "새 워크스페이스" })).toBeInTheDocument();
    libraryState = readyState({
      mode: "loading",
      version: null,
      library: null,
      scope: null,
      recovery: null,
      generationEpoch: 1,
    });
    view.rerender(
      <RecorderSessionProvider>
        <div id="app-content">
          <LibraryNavigation />
          <HomeClient />
        </div>
      </RecorderSessionProvider>,
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "새 워크스페이스" })).not.toBeInTheDocument();
    });
  });

  it("does not submit a create form while Korean IME composition is active", async () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "새 워크스페이스" }));
    const input = screen.getByRole("textbox", { name: "워크스페이스 이름" });
    fireEvent.change(input, { target: { value: "새 업무" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });
    expect(libraryState.runLibraryMutation).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.click(screen.getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(libraryState.runLibraryMutation).toHaveBeenCalledTimes(1));
  });

  it("traps the mobile drawer, makes page content inert, and returns focus on Escape", async () => {
    render(
      <RecorderSessionProvider>
        <LibraryNavigation />
        <main id="app-content">본문</main>
      </RecorderSessionProvider>,
    );
    const trigger = screen.getByRole("button", { name: "라이브러리 메뉴 열기" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "라이브러리 메뉴" })).toBeInTheDocument();
    expect(document.getElementById("app-content")).toHaveProperty("inert", true);
    expect(document.body.style.overflow).toBe("hidden");
    await waitFor(() => expect(screen.getByRole("button", { name: "라이브러리 메뉴 닫기" })).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "라이브러리 메뉴" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(document.getElementById("app-content")).toHaveProperty("inert", false);
  });

  it("canonicalizes a cross-workspace folder to the requested workspace All once", async () => {
    navigation.search = `workspace=${OTHER_WORKSPACE}&folder=${FOLDER}`;
    libraryState = readyState({ scope: { kind: "workspace", workspaceId: OTHER_WORKSPACE } });
    render(
      <RecorderSessionProvider>
        <HomeClient />
      </RecorderSessionProvider>,
    );
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith(`/?workspace=${OTHER_WORKSPACE}`));
    expect(navigation.replace).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/회의 위치를 확인하는 중/)).toBeInTheDocument();
  });

  it("keeps stale-conflict form value and dialog open", async () => {
    libraryState = readyState({
      runLibraryMutation: vi.fn(async () => ({
        response: new Response(JSON.stringify({}), { status: 409 }),
        payload: null,
        accepted: true,
      })),
    });
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "새 워크스페이스" }));
    const input = screen.getByRole("textbox", { name: "워크스페이스 이름" });
    fireEvent.change(input, { target: { value: "충돌해도 유지" } });
    fireEvent.click(screen.getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(screen.getByText(/다른 변경이 먼저 저장/)).toBeInTheDocument());
    expect(input).toHaveValue("충돌해도 유지");
    expect(screen.getByRole("dialog", { name: "새 워크스페이스" })).toBeInTheDocument();
  });
});
