// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SearchClient } from "@/components/SearchClient";
import type { LibraryProviderValue } from "@/components/LibraryProvider";
import type { ChatResponse } from "@/domain/chat";
import type { MeetingSearchResponse } from "@/lib/meetingSearch";

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: {
    href: string;
    children: import("react").ReactNode;
  }) => <a href={href} {...props}>{children}</a>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  usePathname: () => "/search",
  useSearchParams: () => new URLSearchParams(),
}));

const WORKSPACE = "10000000-0000-4000-8000-000000000001";
const FOLDER = "30000000-0000-4000-8000-000000000003";

const libraryState = {
  mode: "ready",
  library: {
    defaultWorkspaceId: WORKSPACE,
    workspaces: [{
      id: WORKSPACE,
      name: "기본",
      order: 0,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    }],
    folders: [{
      id: FOLDER,
      workspaceId: WORKSPACE,
      parentFolderId: null,
      name: "제품",
      color: "brown",
      order: 0,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    }],
    counts: {
      visibleMeetingCount: 1,
      hiddenInvalidStatusCount: 0,
      organizationPendingCount: 0,
      workspaces: [{ workspaceId: WORKSPACE, total: 1, unfiled: 0 }],
      folders: [{ folderId: FOLDER, direct: 1 }],
    },
  },
} as LibraryProviderValue;

vi.mock("@/components/LibraryProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/LibraryProvider")>();
  return {
    ...actual,
    useOptionalLibrary: () => libraryState,
  };
});

function resultPayload(overrides: Partial<MeetingSearchResponse> = {}): MeetingSearchResponse {
  return {
    query: "로드맵",
    results: [{
      meetingId: "meeting-1",
      title: "제품 로드맵 회의",
      status: "summarized",
      startedAt: "2026-07-12T00:00:00.000Z",
      location: {
        workspaceId: WORKSPACE,
        folderId: FOLDER,
        breadcrumb: ["기본", "제품"],
      },
      matches: [{ field: "decisions", label: "결정", excerpt: "로드맵을 다음 분기에 출시하기로 결정" }],
      href: "/meetings/meeting-1",
    }],
    hasMore: false,
    summaryPendingCount: 0,
    index: { status: "ready", reasons: [], reindexable: false },
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chatPayload(): ChatResponse {
  return {
    answerSegments: [{
      kind: "claim",
      format: "paragraph",
      text: "제품 로드맵은 다음 분기에 출시하기로 결정했습니다.",
      referenceNumbers: [1],
    }],
    references: [{
      number: 1,
      meetingId: "meeting-1",
      currentTitle: "제품 로드맵 회의",
      startedAt: "2026-07-12T00:00:00.000Z",
      href: "/meetings/meeting-1",
    }],
    evidenceStatus: "sufficient",
    checkedScope: {
      searchResults: 1,
      knowledgeCards: 1,
      summaries: 1,
      transcriptWindows: 0,
      fullTranscripts: 0,
      distinctMeetings: 1,
    },
    warnings: [],
  };
}

function stubFetch(options: {
  payload?: MeetingSearchResponse;
  searchStatus?: number;
  reindexStatus?: number;
} = {}) {
  const payload = options.payload ?? resultPayload();
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/knowledge/reindex") {
      return response(options.reindexStatus && options.reindexStatus !== 200
        ? { error: { code: "internal_error" } }
        : { status: "ready", reasons: [], count: { total: 1, indexed: 1, skipped: 0 }, durability: "durable" },
      options.reindexStatus ?? 200);
    }
    if (url.startsWith("/api/search?")) {
      return response(options.searchStatus && options.searchStatus !== 200
        ? { error: { code: "internal_error" } }
        : payload,
      options.searchStatus ?? 200);
    }
    if (url === "/api/chat") return response(chatPayload());
    throw new Error(`unexpected URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function openSearchTab() {
  fireEvent.click(screen.getByRole("tab", { name: "검색" }));
}

function submit(query = "로드맵") {
  openSearchTab();
  const input = screen.getByRole("searchbox", { name: "회의 검색" });
  fireEvent.change(input, { target: { value: query } });
  fireEvent.click(screen.getByRole("button", { name: /^검색$/ }));
  return input;
}

beforeEach(() => {
  navigation.push.mockReset();
  navigation.replace.mockReset();
  navigation.refresh.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SearchClient", () => {
  it("opens the Question tab by default and renders only the selected input and primary action", () => {
    stubFetch();
    render(<SearchClient />);

    expect(screen.getByRole("tab", { name: "질문" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox", { name: "회의에 질문" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "질문하기" })).toHaveLength(1);
    expect(screen.queryByRole("searchbox", { name: "회의 검색" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^검색$/ })).not.toBeInTheDocument();

    openSearchTab();
    expect(screen.getByRole("searchbox", { name: "회의 검색" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^검색$/ })).toHaveLength(1);
    expect(screen.queryByRole("textbox", { name: "회의에 질문" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "질문하기" })).not.toBeInTheDocument();
  });

  it("preserves completed chat and search state across tab round trips", async () => {
    stubFetch();
    render(<SearchClient />);

    const question = screen.getByRole("textbox", { name: "회의에 질문" });
    fireEvent.change(question, { target: { value: "로드맵 결정은?" } });
    fireEvent.click(screen.getByRole("button", { name: "질문하기" }));
    expect(await screen.findByText(/다음 분기에 출시/)).toBeInTheDocument();

    openSearchTab();
    fireEvent.click(screen.getByText("필터", { selector: "span" }));
    fireEvent.change(screen.getByLabelText("상태"), { target: { value: "summarized" } });
    const searchInput = submit("로드맵");
    expect(await screen.findByRole("heading", { name: "제품 로드맵 회의" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "질문" }));
    expect(screen.getByText(/다음 분기에 출시/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "검색" }));
    expect(searchInput).toHaveValue("로드맵");
    expect(screen.getByLabelText("상태")).toHaveValue("summarized");
    expect(screen.getByRole("heading", { name: "제품 로드맵 회의" })).toBeInTheDocument();
  });

  it("uses an explicit primary submit and ignores Enter during Korean IME composition", async () => {
    const fetchMock = stubFetch();
    render(<SearchClient />);
    openSearchTab();
    const input = screen.getByRole("searchbox", { name: "회의 검색" });
    const submitButton = screen.getByRole("button", { name: /^검색$/ });
    expect(submitButton).toBeDisabled();

    fireEvent.change(input, { target: { value: "로드맵" } });
    expect(submitButton).toBeEnabled();
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/search?q=%EB%A1%9C%EB%93%9C%EB%A7%B5");
  });

  it("groups progressive filters in a disclosure, counts active filters, and keeps reset in mobile semantic order", () => {
    stubFetch();
    render(<SearchClient />);
    openSearchTab();

    const disclosureSummary = screen.getByText("필터", { selector: "span" });
    const disclosure = disclosureSummary.closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    expect(screen.getByText("활성 필터 0개")).toBeInTheDocument();
    const reset = screen.getByRole("button", { name: "필터 초기화" });
    expect(reset).toBeDisabled();

    fireEvent.click(disclosureSummary);
    fireEvent.change(screen.getByLabelText("시작 날짜"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("워크스페이스"), { target: { value: WORKSPACE } });
    fireEvent.change(screen.getByLabelText("폴더"), { target: { value: FOLDER } });
    fireEvent.click(screen.getByRole("checkbox", { name: "할 일이 있는 회의만" }));

    expect(screen.getByText("활성 필터 4개")).toBeInTheDocument();
    expect(reset).toBeEnabled();
    const filterFields = screen.getByTestId("search-filter-fields");
    expect(filterFields).toHaveClass("flex-col", "sm:grid");
    expect(reset.compareDocumentPosition(filterFields) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();

    fireEvent.click(reset);
    expect(screen.getByText("활성 필터 0개")).toBeInTheDocument();
    expect(screen.getByLabelText("시작 날짜")).toHaveValue("");
    expect(screen.getByLabelText("워크스페이스")).toHaveValue("");
  });

  it("renders a divider list with strong live title, one metadata group, match reasons, and a 44px open action", async () => {
    stubFetch();
    const view = render(<SearchClient />);
    submit();

    const heading = await screen.findByRole("heading", { level: 3, name: "제품 로드맵 회의" });
    const row = heading.closest("li");
    expect(row).not.toBeNull();
    expect(row?.parentElement).toHaveAttribute("data-result-layout", "divider-list");
    expect(row).toHaveClass("border-t");
    expect(within(row as HTMLElement).getByLabelText("회의 메타데이터"))
      .toHaveTextContent(/2026-07-12.*기본 \/ 제품.*요약 완료/);
    expect(within(row as HTMLElement).getByText("결정")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText(/다음 분기에 출시/)).toBeInTheDocument();
    expect(within(row as HTMLElement).getByRole("link", { name: "회의 열기" }))
      .toHaveAttribute("href", "/meetings/meeting-1");
    expect(within(row as HTMLElement).getByRole("link", { name: "회의 열기" }))
      .toHaveClass("min-h-11");
    expect(view.container.querySelector("[data-search-result-card]")).toBeNull();
  });

  it("distinguishes no results and offers query reduction plus filter reset", async () => {
    stubFetch({ payload: resultPayload({ results: [], query: "너무 긴 검색", hasMore: false }) });
    render(<SearchClient />);
    openSearchTab();
    fireEvent.click(screen.getByText("필터", { selector: "span" }));
    fireEvent.change(screen.getByLabelText("상태"), { target: { value: "summarized" } });
    submit("너무 긴 검색");

    expect(await screen.findByRole("heading", { name: "검색 결과가 없습니다" })).toBeInTheDocument();
    expect(screen.getByText(/검색어를 줄이거나/)).toBeInTheDocument();
    const resets = screen.getAllByRole("button", { name: "필터 초기화" });
    expect(resets.some((button) => !button.hasAttribute("disabled"))).toBe(true);
  });

  it("uses user-facing recovery copy for partial/missing data and keeps valid results visible", async () => {
    stubFetch({
      payload: resultPayload({
        index: { status: "partial", reasons: ["missing", "stale", "corrupt"], reindexable: true },
        summaryPendingCount: 2,
      }),
    });
    const view = render(<SearchClient />);
    submit();

    expect(await screen.findByText(/일부 회의의 검색 데이터가 아직 최신 상태가 아닙니다/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "제품 로드맵 회의" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "검색 데이터 업데이트" })).toBeInTheDocument();
    expect(screen.getByText(/요약 대기 회의 2개/)).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent(/\bindex\b|\bstale\b|\bcorrupt\b/i);
  });

  it("shows unavailable and request-error states without replacing the draft", async () => {
    const unavailable = resultPayload({
      results: [],
      index: { status: "unavailable", reasons: ["missing"], reindexable: true },
    });
    stubFetch({ payload: unavailable });
    const view = render(<SearchClient />);
    const input = submit("보존할 검색어");

    expect(await screen.findByRole("heading", { name: "검색 데이터를 사용할 수 없습니다" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "검색 데이터 업데이트" })).toBeInTheDocument();
    expect(input).toHaveValue("보존할 검색어");
    expect(view.container).not.toHaveTextContent(/\bindex\b|\bstale\b|\bcorrupt\b/i);
  });

  it("explains hasMore as refinement without rendering unsupported pagination", async () => {
    stubFetch({ payload: resultPayload({ hasMore: true }) });
    render(<SearchClient />);
    submit();

    expect(await screen.findByText("상위 20개 결과를 표시했습니다.")).toBeInTheDocument();
    expect(screen.getByText(/검색어나 필터를 좁혀/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /다음|이전|더 보기/ })).not.toBeInTheDocument();
  });

  it("reindexes without clearing query/filter/result and reruns the same search after success", async () => {
    const fetchMock = stubFetch({
      payload: resultPayload({
        index: { status: "partial", reasons: ["stale"], reindexable: true },
      }),
    });
    render(<SearchClient />);
    openSearchTab();
    fireEvent.click(screen.getByText("필터", { selector: "span" }));
    fireEvent.change(screen.getByLabelText("상태"), { target: { value: "summarized" } });
    const input = submit("로드맵");
    await screen.findByRole("heading", { name: "제품 로드맵 회의" });

    const update = screen.getByRole("button", { name: "검색 데이터 업데이트" });
    fireEvent.click(update);
    expect(input).toHaveValue("로드맵");
    expect(screen.getByLabelText("상태")).toHaveValue("summarized");
    expect(screen.getByRole("heading", { name: "제품 로드맵 회의" })).toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/knowledge/reindex");
    const rerunUrl = String(fetchMock.mock.calls[2][0]);
    expect(rerunUrl).toContain("q=%EB%A1%9C%EB%93%9C%EB%A7%B5");
    expect(rerunUrl).toContain("status=summarized");
  });

  it("keeps existing results, draft, filters, and focus when reindex fails", async () => {
    stubFetch({
      payload: resultPayload({
        index: { status: "partial", reasons: ["corrupt"], reindexable: true },
      }),
      reindexStatus: 500,
    });
    render(<SearchClient />);
    openSearchTab();
    const input = submit("로드맵");
    await screen.findByRole("heading", { name: "제품 로드맵 회의" });
    fireEvent.change(input, { target: { value: "수정 중인 검색어" } });
    const update = screen.getByRole("button", { name: "검색 데이터 업데이트" });
    update.focus();
    fireEvent.click(update);

    expect(await screen.findByText(/검색 데이터를 업데이트하지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "제품 로드맵 회의" })).toBeInTheDocument();
    expect(input).toHaveValue("수정 중인 검색어");
    expect(update).toHaveFocus();
  });
});
