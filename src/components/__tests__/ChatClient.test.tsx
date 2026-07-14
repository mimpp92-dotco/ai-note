// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "@/components/ChatPanel";
import { RecorderSessionProvider } from "@/components/RecorderSessionProvider";
import type { LibraryProviderValue } from "@/components/LibraryProvider";
import type { ChatRequest, ChatResponse } from "@/domain/chat";
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

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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

function searchPayload(): MeetingSearchResponse {
  return {
    query: "로드맵",
    results: [{
      meetingId: "meeting-1",
      title: "제품 로드맵 회의",
      status: "summarized",
      startedAt: "2026-07-12T00:00:00.000Z",
      location: { workspaceId: WORKSPACE, folderId: FOLDER, breadcrumb: ["기본", "제품"] },
      matches: [{ field: "decisions", label: "결정", excerpt: "9월 출시" }],
      href: "/meetings/meeting-1",
    }],
    hasMore: false,
    summaryPendingCount: 0,
    index: { status: "ready", reasons: [], reindexable: false },
  };
}

type ChatResponder = (body: ChatRequest, callIndex: number) => Response | Promise<Response>;

function stubFetch(chatResponder: ChatResponder, options: {
  search?: MeetingSearchResponse;
  reindexStatus?: number;
} = {}) {
  const chatBodies: ChatRequest[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/chat") {
      const body = JSON.parse(String(init?.body)) as ChatRequest;
      chatBodies.push(body);
      return chatResponder(body, chatBodies.length - 1);
    }
    if (url.startsWith("/api/search?")) return response(options.search ?? searchPayload());
    if (url === "/api/knowledge/reindex") {
      const status = options.reindexStatus ?? 200;
      return response(status === 200
        ? { status: "ready", reasons: [], count: { total: 1, indexed: 1, skipped: 0 }, durability: "durable" }
        : { error: { code: "internal_error" } }, status);
    }
    throw new Error(`unexpected URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, chatBodies };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

// The chatbot now lives in the app-shell ChatPanel (desktop aside), and its search
// actions open the shared SearchOverlay instead of a /search tab. The harness mounts
// ChatPanel inside RecorderSessionProvider so GuardedLink references resolve.
function renderChat() {
  return render(
    <RecorderSessionProvider>
      <ChatPanel />
    </RecorderSessionProvider>,
  );
}

function composer(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "회의에 질문" });
}

async function ask(question: string) {
  fireEvent.change(composer(), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "질문하기" }));
  await screen.findByText(question, { selector: "h2" });
}

beforeEach(() => {
  navigation.push.mockReset();
  navigation.replace.mockReset();
  navigation.refresh.mockReset();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatClient", () => {
  it("submits normal questions with a visible 1-to-5-line composer and ignores Shift+Enter and IME Enter", async () => {
    const { chatBodies } = stubFetch(() => response(chatPayload()));
    renderChat();

    const input = composer();
    expect(input).toHaveAttribute("rows", "1");
    expect(input).toHaveAttribute("data-max-rows", "5");
    expect(input).toHaveClass("min-w-0", "resize-none");
    expect(screen.getByRole("button", { name: "질문하기" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "이번 결정은?" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: true });
    expect(chatBodies).toHaveLength(0);
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
    expect(chatBodies).toHaveLength(0);
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(chatBodies).toHaveLength(1));
    expect(chatBodies[0]).toEqual({ message: "이번 결정은?", mode: "normal" });
    expect(await screen.findByText(/9월 출시/)).toBeInTheDocument();
  });

  it("shows one honest loading status without fake progress steps and preserves the in-flight draft", async () => {
    const pending = deferred<Response>();
    stubFetch(() => pending.promise);
    const view = renderChat();

    fireEvent.change(composer(), { target: { value: "보존할 질문" } });
    fireEvent.keyDown(composer(), { key: "Enter", code: "Enter" });
    expect(screen.getByRole("status")).toHaveTextContent("답변을 준비하고 있습니다");
    expect(view.container).not.toHaveTextContent(/지도 확인|요약 읽기|원문 확인/);
    expect(screen.getByRole("button", { name: "질문하기" })).toBeDisabled();
    expect(composer()).toHaveValue("보존할 질문");

    await act(async () => pending.resolve(response(chatPayload())));
    expect(await screen.findByText(/9월 출시/)).toBeInTheDocument();
    expect(screen.getByText("답변이 준비되었습니다.")).toBeInTheDocument();
  });

  it("sends bounded complete history with turn-local reference maps and clears the conversation", async () => {
    const { chatBodies } = stubFetch((_body, index) => response(chatPayload({
      answerSegments: [{
        kind: "claim",
        format: "paragraph",
        text: `${index + 1}번째 답변입니다.`,
        referenceNumbers: [1],
      }],
      references: [{
        number: 1,
        meetingId: `meeting-${index + 1}`,
        currentTitle: `${index + 1}번째 회의`,
        startedAt: "2026-07-12T00:00:00.000Z",
        href: `/meetings/meeting-${index + 1}`,
      }],
    })));
    renderChat();

    for (let index = 1; index <= 6; index += 1) {
      await ask(`${index}번째 질문`);
      await screen.findByText(`${index}번째 답변입니다.`);
    }

    expect(chatBodies[1].history).toHaveLength(2);
    expect(chatBodies[1].history?.[1]).toMatchObject({
      role: "assistant",
      referenceMap: [{ number: 1, meetingId: "meeting-1" }],
    });
    expect(chatBodies[5].history).toHaveLength(8);
    expect(chatBodies[5].history?.[0]).toMatchObject({ role: "user", content: "2번째 질문" });
    expect(chatBodies[5].history?.map((item) => item.role)).toEqual([
      "user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "대화 지우기" }));
    expect(screen.queryByText("6번째 질문")).not.toBeInTheDocument();
    expect(composer()).toBeInTheDocument();
  });

  it("trims oldest complete pairs before the total history text limit", async () => {
    const { chatBodies } = stubFetch((_body, index) => response(chatPayload({
      answerSegments: Array.from({ length: 13 }, (_, segmentIndex) => ({
        kind: "claim" as const,
        format: "paragraph" as const,
        text: segmentIndex === 0
          ? `${index + 1}번째 긴 답변 ${"가".repeat(470)}`
          : "가".repeat(490),
        referenceNumbers: [1],
      })),
      references: [{
        number: 1,
        meetingId: `long-meeting-${index + 1}`,
        currentTitle: `${index + 1}번째 긴 회의`,
        startedAt: "2026-07-12T00:00:00.000Z",
        href: `/meetings/long-meeting-${index + 1}`,
      }],
    })));
    renderChat();

    for (let index = 1; index <= 5; index += 1) {
      await ask(`${index}번째 긴 질문`);
      await screen.findByText(new RegExp(`${index}번째 긴 답변`));
    }

    const history = chatBodies[4].history ?? [];
    expect(history).toHaveLength(6);
    expect(history.map((item) => item.role)).toEqual([
      "user", "assistant", "user", "assistant", "user", "assistant",
    ]);
    expect(history.reduce((sum, item) => sum + Array.from(item.content).length, 0)).toBeLessThanOrEqual(24_000);
    expect(history[0]).toMatchObject({ role: "user", content: "2번째 긴 질문" });
  });

  it("renders server-built paragraphs and bullets with stable inline references and a folded checked scope", async () => {
    stubFetch(() => response(chatPayload({
      answerSegments: [
        { kind: "claim", format: "paragraph", text: "출시일은 9월입니다.", referenceNumbers: [1, 2] },
        { kind: "claim", format: "bullet", text: "디자인 검토가 남았습니다.", referenceNumbers: [1] },
        { kind: "limitation", format: "bullet", text: "예산 수치는 확인하지 못했습니다.", referenceNumbers: [] },
      ],
      references: [
        { number: 1, meetingId: "meeting-a", currentTitle: "제품 회의", startedAt: "2026-07-12T00:00:00.000Z", href: "/meetings/meeting-a" },
        { number: 2, meetingId: "meeting-b", currentTitle: "디자인 회의", startedAt: "2026-07-11T00:00:00.000Z", href: "/meetings/meeting-b" },
      ],
    })));
    renderChat();
    await ask("출시일과 남은 일은?");

    const answer = await screen.findByRole("article", { name: "질문 답변" });
    expect(within(answer).getByText(/출시일은 9월/).tagName).toBe("P");
    expect(within(answer).getByText(/디자인 검토가 남았습니다/).closest("li")).not.toBeNull();
    const firstMarkers = within(answer).getAllByRole("link", { name: "출처 1: 제품 회의" });
    expect(firstMarkers).toHaveLength(2);
    expect(firstMarkers[0]).toHaveAttribute("href", firstMarkers[1].getAttribute("href"));
    expect(within(answer).getByRole("link", { name: "출처 2: 디자인 회의" })).toBeInTheDocument();

    const firstTargetId = firstMarkers[0].getAttribute("href")?.slice(1) ?? "";
    const firstTarget = document.getElementById(firstTargetId);
    expect(firstTarget).toHaveAttribute("tabindex", "-1");
    fireEvent.click(firstMarkers[1]);
    expect(firstTarget).toHaveFocus();
    expect(within(firstTarget as HTMLElement).getByRole("link", { name: "회의 열기" }))
      .toHaveClass("min-h-11");

    const scope = within(answer).getByText("확인한 범위").closest("details");
    expect(scope).not.toHaveAttribute("open");
    expect(within(scope as HTMLElement).getByText("탐색 수준 · 기본")).toBeInTheDocument();
    expect(within(answer).getByText("출처 확인됨")).toBeInTheDocument();
  });

  it("uses unique per-turn reference targets and keeps the latest target identity across deep replacement", async () => {
    const { chatBodies } = stubFetch((_body, index) => {
      if (index === 0) return response(chatPayload({
        answerSegments: [{ kind: "claim", format: "paragraph", text: "첫 답변입니다.", referenceNumbers: [1] }],
        references: [{ number: 1, meetingId: "meeting-first", currentTitle: "첫 회의", startedAt: "2026-07-10T00:00:00.000Z", href: "/meetings/meeting-first" }],
      }));
      if (index === 1) return response(chatPayload({
        answerSegments: [{ kind: "claim", format: "paragraph", text: "둘째 답변입니다.", referenceNumbers: [1] }],
        references: [{ number: 1, meetingId: "meeting-second", currentTitle: "둘째 회의", startedAt: "2026-07-11T00:00:00.000Z", href: "/meetings/meeting-second" }],
      }));
      return response(chatPayload({
        answerSegments: [{ kind: "claim", format: "paragraph", text: "더 깊게 확인한 둘째 답변입니다.", referenceNumbers: [1] }],
        references: [{ number: 1, meetingId: "meeting-second", currentTitle: "둘째 회의 최신 제목", startedAt: "2026-07-11T00:00:00.000Z", href: "/meetings/meeting-second" }],
      }));
    });
    renderChat();
    await ask("첫 질문");
    await screen.findByText("첫 답변입니다.");
    await ask("둘째 질문");
    await screen.findByText("둘째 답변입니다.");

    const firstHref = screen.getByRole("link", { name: "출처 1: 첫 회의" }).getAttribute("href");
    const secondHref = screen.getByRole("link", { name: "출처 1: 둘째 회의" }).getAttribute("href");
    expect(firstHref).not.toBe(secondHref);
    fireEvent.click(screen.getByRole("button", { name: "더 깊게 찾기" }));

    expect(await screen.findByText("더 깊게 확인한 둘째 답변입니다.")).toBeInTheDocument();
    expect(chatBodies[2].mode).toBe("deep");
    expect(chatBodies[2].message).toBe("둘째 질문");
    expect(chatBodies[2].history).toEqual(chatBodies[1].history);
    expect(screen.getByRole("link", { name: "출처 1: 둘째 회의 최신 제목" }))
      .toHaveAttribute("href", secondHref);
    expect(screen.queryByRole("button", { name: "더 깊게 찾기" })).not.toBeInTheDocument();
  });

  it("rejects an invalid success body without replacing the current answer or failed draft", async () => {
    stubFetch((_body, index) => index === 0
      ? response(chatPayload())
      : response({
          ...chatPayload(),
          answerSegments: [{ kind: "claim", format: "paragraph", text: "검증되지 않은 새 답변입니다.", referenceNumbers: [2] }],
        }));
    renderChat();
    await ask("첫 질문");
    expect(await screen.findByText(/9월 출시/)).toBeInTheDocument();

    fireEvent.change(composer(), { target: { value: "실패할 질문" } });
    fireEvent.click(screen.getByRole("button", { name: "질문하기" }));
    expect(await screen.findByText(/답변 형식을 확인하지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByText(/9월 출시/)).toBeInTheDocument();
    expect(screen.queryByText("검증되지 않은 새 답변입니다.")).not.toBeInTheDocument();
    expect(composer()).toHaveValue("실패할 질문");
  });

  it("shows personalization only when requested and provides actionable model and search-data recovery", async () => {
    const first = renderChat();
    stubFetch(() => response(chatPayload()));
    await ask("일반 질문");
    expect(await screen.findByText(/9월 출시/)).toBeInTheDocument();
    expect(screen.queryByText(/내 정보를 설정/)).not.toBeInTheDocument();
    first.unmount();

    stubFetch(() => response(chatPayload({ warnings: ["personalization_needed"] })));
    const personalized = renderChat();
    await ask("내 할 일은?");
    expect(await screen.findByText(/내 정보를 설정하면/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "내 정보 설정" })).toHaveAttribute("href", "/settings");
    personalized.unmount();

    stubFetch(() => response({ error: { code: "chat_llm_unconfigured" } }, 409));
    const modelError = renderChat();
    fireEvent.change(composer(), { target: { value: "보존할 모델 질문" } });
    fireEvent.click(screen.getByRole("button", { name: "질문하기" }));
    expect(await screen.findByText(/요약 모델 설정이 필요합니다/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "요약 모델 설정" })).toHaveAttribute("href", "/settings");
    expect(composer()).toHaveValue("보존할 모델 질문");
    modelError.unmount();

    stubFetch(() => response({ error: { code: "chat_index_unavailable" } }, 503));
    renderChat();
    fireEvent.change(composer(), { target: { value: "보존할 검색 질문" } });
    fireEvent.click(screen.getByRole("button", { name: "질문하기" }));
    expect(await screen.findByText(/검색 데이터를 사용할 수 없어/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "검색 데이터 업데이트" })).toBeInTheDocument();
    expect(composer()).toHaveValue("보존할 검색 질문");
  });

  it("keeps the prior answer when a deep rerun fails", async () => {
    stubFetch((_body, index) => index === 0
      ? response(chatPayload())
      : response({ error: { code: "chat_llm_unavailable" } }, 503));
    renderChat();
    await ask("깊게 볼 질문");
    expect(await screen.findByText(/9월 출시/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "더 깊게 찾기" }));

    expect(await screen.findByText(/더 깊게 확인하지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByText(/9월 출시/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "요약 모델 확인" })).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("button", { name: "더 깊게 찾기" })).toBeEnabled();
  });

  it("copies inline markers and safe references, then replays a server-built search in the overlay", async () => {
    const writeText = vi.fn(async (text: string) => {
      void text;
    });
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { fetchMock } = stubFetch(() => response(chatPayload({
      answerSegments: [{ kind: "claim", format: "paragraph", text: "두 회의에서 출시일을 확인했습니다.", referenceNumbers: [1, 2] }],
      references: [
        { number: 1, meetingId: "meeting-a", currentTitle: "제품 회의", startedAt: "2026-07-12T00:00:00.000Z", href: "/meetings/meeting-a" },
        { number: 2, meetingId: "meeting-b", currentTitle: "출시 회의", startedAt: "2026-07-11T00:00:00.000Z", href: "/meetings/meeting-b" },
      ],
      searchReplay: {
        query: "출시일",
        filters: { workspaceId: WORKSPACE, status: "summarized" },
        limit: 20,
        resultCount: 1,
      },
    })));
    renderChat();
    await ask("출시일은?");
    await screen.findByText(/두 회의에서/);

    fireEvent.click(screen.getByRole("button", { name: "답변 복사" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0][0]);
    expect(copied).toContain("두 회의에서 출시일을 확인했습니다.[1][2]");
    expect(copied).toContain("참고 회의\n[1] 제품 회의 · 2026-07-12");
    expect(copied).toContain("[2] 출시 회의 · 2026-07-11");
    expect(copied).not.toMatch(/meeting-a|meeting-b|\/meetings\//);

    fireEvent.click(screen.getByRole("button", { name: "검색 결과로 보기" }));
    const overlay = await screen.findByRole("dialog", { name: "회의 검색" });
    expect(overlay).toHaveAttribute("open");
    expect(within(overlay).getByRole("searchbox", { name: "회의 검색" })).toHaveValue("출시일");
    expect(within(overlay).getByLabelText("워크스페이스")).toHaveValue(WORKSPACE);
    expect(within(overlay).getByLabelText("상태")).toHaveValue("summarized");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/search?"))).toBe(true));
  });

  it("distinguishes partial and no-source answers with user-facing recovery copy only", async () => {
    const view = renderChat();
    stubFetch((_body, index) => index === 0
      ? response(chatPayload({
          evidenceStatus: "partial",
          warnings: ["index_partial", "candidate_limit_reached", "budget_exhausted"],
        }))
      : response(chatPayload({
          answerSegments: [{ kind: "limitation", format: "paragraph", text: "확인할 회의를 찾지 못했습니다.", referenceNumbers: [] }],
          references: [],
          evidenceStatus: "none",
          checkedScope: {
            searchResults: 0,
            knowledgeCards: 0,
            summaries: 0,
            transcriptWindows: 0,
            fullTranscripts: 0,
            distinctMeetings: 0,
          },
          warnings: [],
        })));
    await ask("부분 답변");
    expect(await screen.findByText("일부 출처만 확인")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "검색 데이터 업데이트" })).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent(/\bindex\b|\bstale\b|\bbudget\b|\bclaim\b|\btool\b/i);

    await ask("근거 없는 답변");
    expect(await screen.findByText("확인된 출처 없음")).toBeInTheDocument();
    expect(screen.getByText(/질문의 범위를 줄이거나/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "검색에서 찾아보기" })).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent(/\bindex\b|\bstale\b|\bbudget\b|\bclaim\b|\btool\b/i);
  });
});
