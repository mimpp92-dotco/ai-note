// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "@/components/ChatPanel";
import { RecorderSessionProvider } from "@/components/RecorderSessionProvider";
import type { ChatResponse } from "@/domain/chat";

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
}));

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function searchResponse(query: string): unknown {
  return {
    query,
    results: [{
      meetingId: "meeting-1",
      title: "제품 로드맵 회의",
      status: "summarized",
      startedAt: "2026-07-12T00:00:00.000Z",
      location: null,
      matches: [],
      href: "/meetings/meeting-1",
    }],
    hasMore: false,
    summaryPendingCount: 0,
    index: { status: "ready", reasons: [], reindexable: true },
  };
}

function chatPayload(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    answerSegments: [{
      kind: "claim",
      format: "paragraph",
      text: "제품 로드맵은 9월 출시로 결정했습니다.",
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
      searchResults: 3,
      knowledgeCards: 2,
      summaries: 1,
      transcriptWindows: 0,
      fullTranscripts: 0,
      distinctMeetings: 2,
    },
    warnings: [],
    ...overrides,
  };
}

function renderPanel() {
  return render(
    <RecorderSessionProvider>
      <ChatPanel />
    </RecorderSessionProvider>,
  );
}

function desktopComposer(): HTMLTextAreaElement {
  const aside = screen.getByRole("complementary", { name: "회의 도우미" });
  return within(aside).getByRole("textbox", { name: "회의에 질문" }) as HTMLTextAreaElement;
}

beforeEach(() => {
  navigation.push.mockReset();
  navigation.replace.mockReset();
  navigation.refresh.mockReset();
  window.history.replaceState({}, "", "/");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatPanel", () => {
  it("renders a labeled complementary panel by default and no second nav landmark", () => {
    renderPanel();
    const aside = screen.getByRole("complementary", { name: "회의 도우미" });
    expect(within(aside).getByRole("textbox", { name: "회의에 질문" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("collapses to a reopen toggle and re-expands, preserving the in-flight draft", () => {
    renderPanel();
    fireEvent.change(desktopComposer(), { target: { value: "보존할 초안" } });
    expect(desktopComposer()).toHaveValue("보존할 초안");

    fireEvent.click(screen.getByRole("button", { name: "회의 도우미 접기" }));
    expect(screen.queryByRole("complementary", { name: "회의 도우미" })).not.toBeInTheDocument();
    const reopen = screen.getByRole("button", { name: "회의 도우미 펼치기" });
    expect(reopen).toBeInTheDocument();

    fireEvent.click(reopen);
    expect(screen.getByRole("complementary", { name: "회의 도우미" })).toBeInTheDocument();
    expect(desktopComposer()).toHaveValue("보존할 초안");
  });

  it("keeps the conversation across a collapse/expand round trip", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(chatPayload())));
    renderPanel();
    fireEvent.change(desktopComposer(), { target: { value: "이번 결정은?" } });
    const aside = screen.getByRole("complementary", { name: "회의 도우미" });
    fireEvent.click(within(aside).getByRole("button", { name: "질문하기" }));
    expect(await screen.findByText(/9월 출시/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "회의 도우미 접기" }));
    expect(screen.queryByText(/9월 출시/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "회의 도우미 펼치기" }));
    expect(screen.getByText(/9월 출시/)).toBeInTheDocument();
  });

  it("opens a mobile drawer with initial focus on close and returns focus to the launcher", async () => {
    renderPanel();
    const launcher = screen.getByRole("button", { name: "회의 도우미 열기" });
    fireEvent.click(launcher);

    const dialog = screen.getByRole("dialog", { name: "회의 도우미" });
    const close = within(dialog).getByRole("button", { name: "회의 도우미 닫기" });
    await waitFor(() => expect(close).toHaveFocus());
    expect(within(dialog).getByRole("textbox", { name: "회의에 질문" })).toBeInTheDocument();

    fireEvent.click(close);
    await waitFor(() => expect(launcher).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "회의 도우미" })).not.toBeInTheDocument();
  });

  it("uses fade-only transitions that reduced motion suppresses, without slide animation", () => {
    renderPanel();
    const aside = screen.getByRole("complementary", { name: "회의 도우미" });
    expect(aside.className).toContain("transition-opacity");
    expect(aside.className).toContain("motion-reduce:transition-none");
    expect(aside.className).not.toContain("transition-transform");
    expect(aside.className).not.toMatch(/animate-(?!none)/);
  });

  it("offsets its toggle and launcher away from the bottom-right recording widget", () => {
    renderPanel();
    const launcher = screen.getByRole("button", { name: "회의 도우미 열기" });
    expect(launcher.className).toContain("left-4");
    expect(launcher.className).not.toContain("right-4");

    fireEvent.click(screen.getByRole("button", { name: "회의 도우미 접기" }));
    const reopen = screen.getByRole("button", { name: "회의 도우미 펼치기" });
    expect(reopen.className).toContain("top-1/2");
    expect(reopen.className).not.toContain("bottom-4");
  });

  it("opens the in-shell search overlay for a chat search replay instead of navigating to a page", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/search")) return response(searchResponse("제품 로드맵"));
      return response(chatPayload({
        searchReplay: {
          query: "제품 로드맵",
          filters: {},
          limit: 20,
          resultCount: 1,
        },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();

    fireEvent.change(desktopComposer(), { target: { value: "로드맵 결정은?" } });
    const aside = screen.getByRole("complementary", { name: "회의 도우미" });
    fireEvent.click(within(aside).getByRole("button", { name: "질문하기" }));

    const replayButton = await screen.findByRole("button", { name: "검색 결과로 보기" });
    fireEvent.click(replayButton);

    const overlay = await screen.findByRole("dialog", { name: "회의 검색" });
    expect(overlay).toHaveAttribute("open");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/search"),
        expect.anything(),
      ),
    );
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("opens the in-shell search overlay when the answer has no replay to run", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(chatPayload({
      answerSegments: [{
        kind: "limitation",
        format: "paragraph",
        text: "관련 회의를 찾지 못했습니다.",
        referenceNumbers: [],
      }],
      references: [],
      evidenceStatus: "none",
    }))));
    renderPanel();

    fireEvent.change(desktopComposer(), { target: { value: "로드맵 결정은?" } });
    const aside = screen.getByRole("complementary", { name: "회의 도우미" });
    fireEvent.click(within(aside).getByRole("button", { name: "질문하기" }));

    const switchButton = await screen.findByRole("button", { name: "검색에서 찾아보기" });
    fireEvent.click(switchButton);

    const overlay = await screen.findByRole("dialog", { name: "회의 검색" });
    expect(overlay).toHaveAttribute("open");
    expect(navigation.push).not.toHaveBeenCalled();
  });
});
