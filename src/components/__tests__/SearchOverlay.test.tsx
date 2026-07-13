// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SearchOverlay } from "@/components/SearchOverlay";
import type { LibraryProviderValue } from "@/components/LibraryProvider";
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
  usePathname: () => "/",
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
    throw new Error(`unexpected URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function Harness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>검색 열기</button>
      <SearchOverlay open={open} onDismiss={() => setOpen(false)} returnFocus={triggerRef.current} />
    </>
  );
}

function openOverlay() {
  fireEvent.click(screen.getByRole("button", { name: "검색 열기" }));
}

function submit(query = "로드맵") {
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

describe("SearchOverlay", () => {
  it("opens from the trigger, focuses the search input, and returns focus on Escape", async () => {
    stubFetch();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "검색 열기" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "회의 검색" });
    const input = within(dialog).getByRole("searchbox", { name: "회의 검색" });
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("renders a single dark 검색 primary action and no chat composer", () => {
    stubFetch();
    render(<Harness />);
    openOverlay();
    const buttons = screen.getAllByRole("button", { name: /^검색$/ });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveClass("bg-ink");
    expect(screen.queryByRole("textbox", { name: "회의에 질문" })).not.toBeInTheDocument();
  });

  it("shows the initial prompt before any search", () => {
    stubFetch();
    render(<Harness />);
    openOverlay();
    expect(screen.getByRole("heading", { name: "회의를 찾아보세요" })).toBeInTheDocument();
  });

  it("renders results through the shared divider list", async () => {
    stubFetch();
    render(<Harness />);
    openOverlay();
    submit();
    const heading = await screen.findByRole("heading", { level: 3, name: "제품 로드맵 회의" });
    const row = heading.closest("li");
    expect(row).not.toBeNull();
    expect(row?.parentElement).toHaveAttribute("data-result-layout", "divider-list");
    expect(within(row as HTMLElement).getByRole("link", { name: "회의 열기" }))
      .toHaveAttribute("href", "/meetings/meeting-1");
  });

  it("distinguishes the empty state", async () => {
    stubFetch({ payload: resultPayload({ results: [], query: "없는 검색어", hasMore: false }) });
    render(<Harness />);
    openOverlay();
    submit("없는 검색어");
    expect(await screen.findByRole("heading", { name: "검색 결과가 없습니다" })).toBeInTheDocument();
  });

  it("shows the unavailable state while preserving the draft", async () => {
    stubFetch({
      payload: resultPayload({
        results: [],
        index: { status: "unavailable", reasons: ["missing"], reindexable: true },
      }),
    });
    render(<Harness />);
    openOverlay();
    const input = submit("보존할 검색어");
    expect(await screen.findByRole("heading", { name: "검색 데이터를 사용할 수 없습니다" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "검색 데이터 업데이트" })).toBeInTheDocument();
    expect(input).toHaveValue("보존할 검색어");
  });

  it("surfaces a request error without losing the draft", async () => {
    stubFetch({ searchStatus: 500 });
    render(<Harness />);
    openOverlay();
    const input = submit("실패해도 유지");
    expect(await screen.findByText(/검색 요청을 완료하지 못했습니다/)).toBeInTheDocument();
    expect(input).toHaveValue("실패해도 유지");
  });

  it("reindexes partial data and reruns the same query without clearing results", async () => {
    const fetchMock = stubFetch({
      payload: resultPayload({
        index: { status: "partial", reasons: ["stale"], reindexable: true },
      }),
    });
    render(<Harness />);
    openOverlay();
    const input = submit("로드맵");
    await screen.findByRole("heading", { name: "제품 로드맵 회의" });
    expect(screen.getByText(/일부 회의의 검색 데이터가 아직 최신 상태가 아닙니다/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "검색 데이터 업데이트" }));
    expect(input).toHaveValue("로드맵");
    expect(screen.getByRole("heading", { name: "제품 로드맵 회의" })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/knowledge/reindex");
    expect(String(fetchMock.mock.calls[2][0])).toContain("q=%EB%A1%9C%EB%93%9C%EB%A7%B5");
  });

  it("ignores Enter during Korean IME composition and uses the explicit submit", async () => {
    const fetchMock = stubFetch();
    render(<Harness />);
    openOverlay();
    const input = screen.getByRole("searchbox", { name: "회의 검색" });
    fireEvent.change(input, { target: { value: "로드맵" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("does not render next/previous pagination controls when hasMore is true", async () => {
    stubFetch({ payload: resultPayload({ hasMore: true }) });
    render(<Harness />);
    openOverlay();
    submit();
    expect(await screen.findByText("상위 20개 결과를 표시했습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /다음|이전|더 보기/ })).not.toBeInTheDocument();
  });

  it("preserves the draft and results across close and reopen", async () => {
    stubFetch();
    render(<Harness />);
    openOverlay();
    submit("로드맵");
    await screen.findByRole("heading", { name: "제품 로드맵 회의" });
    const dialog = screen.getByRole("dialog", { name: "회의 검색" });

    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));

    openOverlay();
    const reopened = screen.getByRole("dialog", { name: "회의 검색" });
    expect(within(reopened).getByRole("searchbox", { name: "회의 검색" })).toHaveValue("로드맵");
    expect(within(reopened).getByRole("heading", { name: "제품 로드맵 회의" })).toBeInTheDocument();
  });
});
