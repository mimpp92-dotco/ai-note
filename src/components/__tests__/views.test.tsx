import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmptyState } from "@/components/EmptyState";
import { CopyButton } from "@/components/CopyButton";
import { GlossaryClient } from "@/components/GlossaryClient";
import { splitBacklog } from "@/components/HomeClient";
import { MeetingDetailView } from "@/components/MeetingDetailView";
import { MeetingList, type MeetingListItem } from "@/components/MeetingList";
import { PendingBanner } from "@/components/PendingBanner";
import { Recorder } from "@/components/Recorder";
import { RecorderSessionProvider } from "@/components/RecorderSessionProvider";
import { SettingsForm } from "@/components/SettingsForm";
import type { LlmHealthState } from "@/components/healthStatus";
import type { StatusJson } from "@/domain/meeting";
import type { Summary } from "@/domain/summary";

// next/link needs the app-router context at runtime; a plain anchor is enough here.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: import("react").ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// MeetingDetailView uses useRouter. usePathname is stubbed for any transitive
// navigation consumers rendered by these views.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/",
}));

function makeStatus(overrides: Partial<StatusJson> = {}): StatusJson {
  return {
    id: "m1",
    title: "테스트 회의",
    status: "transcribed",
    error: null,
    startedAt: "2026-07-05T13:30:00.000Z",
    endedAt: "2026-07-05T14:00:00.000Z",
    durationMs: 1800000,
    audioMime: "audio/webm;codecs=opus",
    whisper: { jobId: null, progress: 0 },
    paths: { audio: "", play: "", raw: "", transcript: "", summary: "", segments: "" },
    review: { participants: [] },
    updatedAt: "2026-07-05T14:00:00.000Z",
    ...overrides,
  };
}

const SUMMARY: Summary = {
  title: "테스트 회의",
  topicSlug: "test-meeting",
  oneLine: "한 줄 요약입니다.",
  purpose: "회의 목적",
  participants: [],
  highlights: ["핵심 논의 1"],
  discussion: ["논의 상세 1"],
  decisions: ["온보딩을 최우선으로 진행한다."],
  actionItems: [{ owner: "딜런", task: "초안 작성", due: "2026-07-08" }],
  risks: ["일정 지연 가능성"],
  followups: ["리뷰 미팅 잡기"],
};

const PAIR_REVISION = {
  transcriptSha256: "a".repeat(64),
  summarySha256: "b".repeat(64),
};

function stableContent(overrides: Record<string, unknown> = {}) {
  return {
    state: "stable" as const,
    revision: PAIR_REVISION,
    transcriptSource: "generated" as const,
    summarySource: "generated" as const,
    summaryOutdated: false,
    ...overrides,
  };
}

function editableSummary(summary: Summary = SUMMARY) {
  return {
    oneLine: summary.oneLine,
    purpose: summary.purpose,
    highlights: [...summary.highlights],
    discussion: [...summary.discussion],
    decisions: [...summary.decisions],
    actionItems: summary.actionItems.map((item) => ({ ...item })),
    risks: [...summary.risks],
    followups: [...summary.followups],
  };
}

function contentResource(overrides: Record<string, unknown> = {}) {
  return {
    transcript: "본문",
    summary: editableSummary(),
    revision: PAIR_REVISION,
    transcriptSource: "generated",
    summarySource: "generated",
    summaryOutdated: false,
    pairState: "stable",
    ...overrides,
  };
}

function stubClipboard(writeText: ReturnType<typeof vi.fn>) {
  vi.stubGlobal(
    "navigator",
    Object.assign(Object.create(window.navigator), {
      clipboard: { writeText },
    }),
  );
}

function healthResponse(input: string | URL | Request): Response {
  const url = String(input);
  if (url === "/api/settings/llm/health") {
    return new Response(JSON.stringify({ configured: false }), {
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ connected: true, ready: true, model: "base" }), {
    headers: { "content-type": "application/json" },
  });
}

describe("EmptyState", () => {
  it("renders the guide and the 3-step flow without terminal commands", () => {
    render(<EmptyState />);
    expect(screen.getByText("아직 회의록이 없습니다")).toBeInTheDocument();
    expect(screen.getByText(/자동으로 전사됩니다/)).toBeInTheDocument();
    expect(screen.queryByText(/\/meeting-summarize/)).not.toBeInTheDocument();
  });
});

describe("PendingBanner", () => {
  it("prompts to configure a model when none is set and meetings await summary", () => {
    render(<PendingBanner count={2} readiness="unconfigured" />);
    expect(screen.getByText("2개 회의가 요약 대기 중")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "설정" })).toBeInTheDocument();
    expect(screen.getByText(/녹음·전사는 모델 없이 동작합니다/)).toBeInTheDocument();
    expect(screen.queryByText(/\/meeting-summarize/)).not.toBeInTheDocument();
  });

  it("shows auto-processing only when a model is ready", () => {
    render(<PendingBanner count={2} readiness="ready" />);
    expect(screen.getByText("2개 회의")).toBeInTheDocument();
    expect(screen.getByText(/요약 자동 처리 중/)).toBeInTheDocument();
  });

  it("does not say auto-processing when the configured model is unavailable", () => {
    render(<PendingBanner count={2} readiness="unavailable" />);
    expect(screen.getByText("2개 회의가 요약 대기 중")).toBeInTheDocument();
    expect(screen.getByText(/요약 모델을 확인하세요/)).toBeInTheDocument();
    expect(screen.queryByText(/요약 자동 처리 중/)).not.toBeInTheDocument();
  });

  it("renders nothing when nothing is pending", () => {
    const { container } = render(<PendingBanner count={0} readiness="unconfigured" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("splits auto-processing and needs-attention when a model is ready", () => {
    render(<PendingBanner count={2} needsAttention={1} readiness="ready" />);
    expect(screen.getByText("2개 회의")).toBeInTheDocument();
    expect(screen.getByText(/요약 자동 처리 중/)).toBeInTheDocument();
    expect(screen.getByText("1개 확인 필요")).toBeInTheDocument();
  });

  it("shows only needs-attention (no false auto-processing) when a summary failed but nothing is pending", () => {
    render(<PendingBanner count={0} needsAttention={2} readiness="ready" />);
    expect(screen.getByText("2개 확인 필요")).toBeInTheDocument();
    expect(screen.queryByText(/요약 자동 처리 중/)).not.toBeInTheDocument();
  });

  it("still renders when only needs-attention is nonzero (pending count zero)", () => {
    const { container } = render(<PendingBanner count={0} needsAttention={1} readiness="ready" />);
    expect(container).not.toBeEmptyDOMElement();
  });

  it("counts needs-attention meetings in the not-ready backlog total", () => {
    render(<PendingBanner count={2} needsAttention={1} readiness="unavailable" />);
    expect(screen.getByText("3개 회의가 요약 대기 중")).toBeInTheDocument();
  });

  it("stacks unavailable copy and its action on mobile without shrinking the text column", () => {
    render(<PendingBanner count={2} readiness="unavailable" />);
    const settings = screen.getByRole("link", { name: "설정" });
    expect(settings.parentElement).toHaveClass("flex-col", "sm:flex-row");
    expect(settings).toHaveClass("w-full", "sm:w-auto", "min-h-11");
    expect(screen.getByText(/요약 모델을 확인하세요/)).toHaveClass("min-w-0");
  });

  it("lets the ready attention action reflow below copy on mobile", () => {
    render(
      <PendingBanner
        count={2}
        needsAttention={1}
        readiness="ready"
        attention={{ meetingId: "attention", cursor: "cursor" }}
      />,
    );
    const action = screen.getByRole("link", { name: "확인할 회의 열기" });
    expect(action.parentElement).toHaveClass("flex-col", "sm:flex-row");
    expect(action).toHaveClass("w-full", "sm:w-auto");
  });
});

describe("CopyButton feedback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("announces clipboard success on screen and through a live region", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<CopyButton text="복사할 내용" label="요약 복사" />);

    fireEvent.click(screen.getByRole("button", { name: "요약 복사" }));

    await waitFor(() => expect(screen.getByText("복사됨")).toBeInTheDocument());
    expect(screen.getByText("복사됨")).toHaveAttribute("aria-live", "polite");
    expect(writeText).toHaveBeenCalledWith("복사할 내용");
  });

  it("does not silently swallow clipboard failure", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("clipboard blocked")));
    render(<CopyButton text="복사할 내용" label="요약 복사" />);

    fireEvent.click(screen.getByRole("button", { name: "요약 복사" }));

    await waitFor(() => expect(screen.getByText("복사 실패")).toBeInTheDocument());
    expect(screen.getByText("복사 실패")).toHaveAttribute("aria-live", "polite");
  });
});

describe("splitBacklog — home banner counts", () => {
  const item = (over: Partial<MeetingListItem>): MeetingListItem => ({
    id: "x",
    title: "t",
    status: "transcribed",
    startedAt: "2026-07-05T13:30:00.000Z",
    error: null,
    ...over,
  });

  it("counts transcribed-without-retry_summary as pending, retry_summary as needs-attention", () => {
    expect(
      splitBacklog([
        item({ id: "a" }),
        item({ id: "b", error: { message: "x", action: "retry_summary" } }),
        item({ id: "c", status: "summarized" }),
        item({ id: "d", status: "transcribing" }),
        item({ id: "e", error: { message: "x", action: "retry_transcription" } }),
      ]),
    ).toEqual({ pending: 2, needsAttention: 1 });
  });

  it("returns zeros for an empty list", () => {
    expect(splitBacklog([])).toEqual({ pending: 0, needsAttention: 0 });
  });
});

describe("Recorder — responsive layout", () => {
  it("모바일에서 녹음 버튼이 본문 옆으로 밀어내지 않도록 줄바꿈 class를 가진다", () => {
    render(<RecorderSessionProvider><Recorder /></RecorderSessionProvider>);
    const heading = screen.getByRole("heading", { name: "회의 녹음" });
    expect(heading.parentElement?.parentElement).toHaveClass("flex-col");
    expect(heading.parentElement?.parentElement).toHaveClass("sm:flex-row");
    expect(screen.getByRole("button", { name: "실시간 기록 시작" })).toHaveClass("w-full");
    expect(screen.getByRole("button", { name: "실시간 기록 시작" })).toHaveClass("sm:w-auto");
    expect(screen.getByRole("button", { name: "실시간 기록 시작" })).toHaveClass("min-h-11");
  });
});

function meeting(over: Partial<MeetingListItem> = {}): MeetingListItem {
  return {
    id: "m1",
    title: "테스트 회의",
    status: "summarized",
    startedAt: "2026-07-05T13:30:00.000Z",
    error: null,
    ...over,
  };
}

describe("MeetingList — 행 액션(케밥)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("summarized 행은 이름 수정과 삭제를 모두 제공한다", () => {
    render(<MeetingList meetings={[meeting()]} onRenamed={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /관리/ }));
    expect(screen.getByRole("button", { name: "이름 수정" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "삭제" })).toBeInTheDocument();
  });

  it("아직 요약되지 않은 행은 삭제만 제공한다(이름 수정 없음)", () => {
    render(<MeetingList meetings={[meeting({ status: "transcribed" })]} onRenamed={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /관리/ }));
    expect(screen.queryByRole("button", { name: "이름 수정" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "삭제" })).toBeInTheDocument();
  });

  it("삭제를 누르면 영구성 확인이 뜨고 포커스가 취소에 있다", () => {
    render(<MeetingList meetings={[meeting()]} onRenamed={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /관리/ }));
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    expect(screen.getByText(/영구 삭제할까요/)).toBeInTheDocument();
    const cancel = screen.getByRole("button", { name: "취소" });
    expect(cancel).toHaveFocus();
  });

  it("삭제 확인 시 DELETE를 호출하고 onDeleted를 부른다", async () => {
    const onDeleted = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    render(<MeetingList meetings={[meeting()]} onRenamed={vi.fn()} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: /관리/ }));
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    fireEvent.click(screen.getByRole("button", { name: "영구 삭제" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("m1"));
    expect(fetchMock).toHaveBeenCalledWith("/api/meetings/m1", expect.objectContaining({ method: "DELETE" }));
  });

  it("삭제가 404면 이미 삭제된 것으로 보고 onDeleted를 부른다", async () => {
    const onDeleted = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    render(<MeetingList meetings={[meeting()]} onRenamed={vi.fn()} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: /관리/ }));
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    fireEvent.click(screen.getByRole("button", { name: "영구 삭제" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("m1"));
  });

  it("삭제가 409면 행을 유지하고 인라인 에러를 보여준다", async () => {
    const onDeleted = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    render(<MeetingList meetings={[meeting()]} onRenamed={vi.fn()} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: /관리/ }));
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    fireEvent.click(screen.getByRole("button", { name: "영구 삭제" }));
    await waitFor(() => expect(screen.getByText(/요약 중에는 삭제할 수 없어요/)).toBeInTheDocument());
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("이름 수정 저장 시 title POST 후 onRenamed를 부른다", async () => {
    const onRenamed = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, title: "새 제목" }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<MeetingList meetings={[meeting()]} onRenamed={onRenamed} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /관리/ }));
    fireEvent.click(screen.getByRole("button", { name: "이름 수정" }));
    const input = screen.getByRole("textbox", { name: /제목/ });
    fireEvent.change(input, { target: { value: "새 제목" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith("m1", "새 제목"));
    expect(fetchMock).toHaveBeenCalledWith("/api/meetings/m1/title", expect.objectContaining({ method: "POST" }));
  });

  it("이름 수정이 409면 인라인 에러를 남기고 onRenamed를 부르지 않는다(편집 유지)", async () => {
    const onRenamed = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    render(<MeetingList meetings={[meeting()]} onRenamed={onRenamed} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /관리/ }));
    fireEvent.click(screen.getByRole("button", { name: "이름 수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: /제목/ }), { target: { value: "새 제목" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.getByText(/이름을 바꿀 수 없어요/)).toBeInTheDocument());
    expect(onRenamed).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: /제목/ })).toHaveValue("새 제목");
    expect(screen.getByRole("textbox", { name: /제목/ })).toHaveFocus();
  });

  it("한국어 IME 조합 Enter는 저장하지 않고 compositionEnd 뒤 Enter만 저장한다", async () => {
    const onRenamed = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    render(<MeetingList meetings={[meeting()]} onRenamed={onRenamed} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /관리/ }));
    fireEvent.click(screen.getByRole("button", { name: "이름 수정" }));
    const input = screen.getByRole("textbox", { name: /제목/ });
    fireEvent.change(input, { target: { value: "새 한국어 제목" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input, { data: "목" });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13, isComposing: false });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith("m1", "새 한국어 제목"));
  });

  it("빈 제목이면 저장 버튼이 비활성이다", () => {
    render(<MeetingList meetings={[meeting()]} onRenamed={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /관리/ }));
    fireEvent.click(screen.getByRole("button", { name: "이름 수정" }));
    const input = screen.getByRole("textbox", { name: /제목/ });
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
  });

  it("메뉴가 열리면 row가 높은 stacking class를 받고 단순 버튼 그룹으로 노출된다", () => {
    render(<MeetingList meetings={[meeting()]} onRenamed={vi.fn()} onDeleted={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /관리/ });
    fireEvent.click(trigger);
    expect(trigger).not.toHaveAttribute("aria-haspopup");
    expect(trigger.closest("li")).toHaveClass("z-30");
    expect(screen.getByRole("button", { name: "이름 수정" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "삭제" })).toBeInTheDocument();
  });

  it("모바일에서 제목과 상태 badge가 세로로 배치될 수 있다", () => {
    const longTitle = "분기별제품로드맵과고객피드백을함께검토하는아주긴회의제목WithoutAnyBreakOpportunity";
    render(<MeetingList meetings={[meeting({
      title: longTitle,
      location: {
        workspaceId: "workspace",
        folderId: "folder",
        breadcrumb: ["아주 긴 워크스페이스", "끊김 없이 길어지는 폴더 breadcrumb"],
      },
    })]} onRenamed={vi.fn()} onDeleted={vi.fn()} />);
    const link = screen.getByRole("link", { name: new RegExp(longTitle) });
    expect(link).toHaveClass("w-full", "self-stretch", "flex-col", "sm:flex-row");
    expect(screen.getByText(longTitle).parentElement).toHaveClass("w-full", "min-w-0");
    expect(screen.getByRole("button", { name: `${longTitle} 관리 메뉴` }))
      .toHaveClass("min-h-11", "min-w-11");
  });

  it("모바일 inline edit은 input과 44px action row를 stack할 수 있다", () => {
    render(<MeetingList meetings={[meeting()]} onRenamed={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /관리/ }));
    fireEvent.click(screen.getByRole("button", { name: "이름 수정" }));
    const input = screen.getByRole("textbox", { name: /제목/ });
    expect(input.closest("div[class*='rounded']")).toHaveClass("flex-col", "sm:flex-row");
    expect(input).toHaveClass("min-h-11");
    expect(screen.getByRole("button", { name: "저장" })).toHaveClass("min-h-11");
    expect(screen.getByRole("button", { name: "취소" })).toHaveClass("min-h-11");
  });

  it("모바일 inline delete confirmation은 copy 아래에 full-width 44px actions를 둔다", () => {
    render(<MeetingList meetings={[meeting()]} onRenamed={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /관리/ }));
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    const confirm = screen.getByRole("button", { name: "영구 삭제" });
    const cancel = screen.getByRole("button", { name: "취소" });
    expect(confirm.parentElement).toHaveClass("flex-col", "sm:flex-row");
    expect(confirm).toHaveClass("min-h-11", "w-full", "sm:w-auto");
    expect(cancel).toHaveClass("min-h-11", "w-full", "sm:w-auto");
  });

  it("outside click으로 메뉴가 닫힌다", () => {
    render(<MeetingList meetings={[meeting()]} onRenamed={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /관리/ }));
    fireEvent.click(document.body);
    expect(screen.queryByRole("button", { name: "삭제" })).not.toBeInTheDocument();
  });

  it("Escape로 메뉴가 닫히고 트리거에 포커스가 돌아온다", () => {
    render(<MeetingList meetings={[meeting()]} onRenamed={vi.fn()} onDeleted={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /관리/ });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "삭제" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe("GlossaryClient — 로드/편집/저장 (fail-closed)", () => {
  afterEach(() => vi.unstubAllGlobals());

  type GetMode = "ok" | "non_ok" | "throw" | "invalid";
  type SaveMode = "ok" | "non_ok" | "throw";

  function stubFetch(
    opts: {
      initial?: { terms: string[]; corrections: { from: string; to: string }[] };
      getMode?: GetMode;
      saveMode?: SaveMode;
    } = {},
  ) {
    const { initial = { terms: [], corrections: [] }, getMode = "ok", saveMode = "ok" } = opts;
    const posted: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posted.push(body);
        if (saveMode === "throw") throw new Error("network");
        if (saveMode === "non_ok") return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => body };
      }
      if (getMode === "throw") throw new Error("network");
      if (getMode === "non_ok") return { ok: false, status: 500, json: async () => ({}) };
      if (getMode === "invalid") return { ok: true, status: 200, json: async () => ({ nope: true }) };
      return { ok: true, status: 200, json: async () => initial };
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, posted };
  }

  it("일반 용어를 추가하면 칩과 카운트가 늘어난다(공백 분리 안 함)", async () => {
    stubFetch();
    render(<GlossaryClient />);
    const input = await screen.findByRole("textbox", { name: "용어 추가" });
    fireEvent.change(input, { target: { value: "프로덕트 로드맵" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("프로덕트 로드맵")).toBeInTheDocument(); // not split on the space
    expect(screen.getByRole("tab", { name: /일반 용어 \(1\)/ })).toBeInTheDocument();
  });

  it("한국어 IME 조합 중 Enter는 일반 용어를 조기 추가하지 않는다", async () => {
    stubFetch();
    render(<GlossaryClient />);
    const input = await screen.findByRole("textbox", { name: "용어 추가" });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "이창규" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(screen.queryByText("이창규")).not.toBeInTheDocument();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("이창규")).toBeInTheDocument();
    expect(screen.queryByText("규")).not.toBeInTheDocument();
  });

  it("쉼표로 여러 용어를 한 번에 추가한다", async () => {
    stubFetch();
    render(<GlossaryClient />);
    const input = await screen.findByRole("textbox", { name: "용어 추가" });
    fireEvent.change(input, { target: { value: "OKR, 로드맵, OKR" } }); // dup dropped
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("tab", { name: /일반 용어 \(2\)/ })).toBeInTheDocument();
  });

  it("교정쌍을 추가하고 저장하면 POST 본문에 담긴다", async () => {
    const { posted } = stubFetch();
    render(<GlossaryClient />);
    fireEvent.click(await screen.findByRole("tab", { name: /교정쌍/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "잘못 인식된 표기(전)" }), { target: { value: "김민중" } });
    fireEvent.change(screen.getByRole("textbox", { name: "올바른 표기(후)" }), { target: { value: "김민준" } });
    fireEvent.click(screen.getByRole("button", { name: "추가" }));
    expect(screen.getByRole("tab", { name: /교정쌍 \(1\)/ })).toBeInTheDocument();

    const save = screen.getByRole("button", { name: "저장" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]).toEqual({ terms: [], corrections: [{ from: "김민중", to: "김민준" }] });
  });

  it("교정쌍은 전·후가 모두 있어야 추가 가능하다", async () => {
    stubFetch();
    render(<GlossaryClient />);
    fireEvent.click(await screen.findByRole("tab", { name: /교정쌍/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "잘못 인식된 표기(전)" }), { target: { value: "김민중" } });
    expect(screen.getByRole("button", { name: "추가" })).toBeDisabled(); // no "to" yet
  });

  it("한국어 IME 조합 중 Enter는 교정쌍을 조기 추가하지 않는다", async () => {
    stubFetch();
    render(<GlossaryClient />);
    fireEvent.click(await screen.findByRole("tab", { name: /교정쌍/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "잘못 인식된 표기(전)" }), { target: { value: "이창규" } });
    const to = screen.getByRole("textbox", { name: "올바른 표기(후)" });
    fireEvent.compositionStart(to);
    fireEvent.change(to, { target: { value: "이창규 PM" } });
    fireEvent.keyDown(to, { key: "Enter", keyCode: 229 });
    expect(screen.queryByText(/이창규 PM/)).not.toBeInTheDocument();
    fireEvent.compositionEnd(to);
    fireEvent.keyDown(to, { key: "Enter" });
    expect(screen.getByText(/이창규 PM/)).toBeInTheDocument();
  });

  it.each<GetMode>(["throw", "non_ok", "invalid"])(
    "GET %s 실패는 빈 단어장이 아니라 load_error로 편집을 잠근다",
    async (getMode) => {
      stubFetch({ getMode });
      render(<GlossaryClient />);
      expect(await screen.findByText(/불러오지 못했어요/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
      // No editor, no save button, and not the empty-ready copy.
      expect(screen.queryByRole("button", { name: "저장" })).not.toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: "용어 추가" })).not.toBeInTheDocument();
      expect(screen.queryByText(/등록된 용어가 없어요/)).not.toBeInTheDocument();
    },
  );

  it("load 실패 뒤에는 저장으로 POST할 수 없다(덮어쓰기 방지)", async () => {
    const { fetchMock } = stubFetch({ getMode: "non_ok" });
    render(<GlossaryClient />);
    await screen.findByText(/불러오지 못했어요/);
    expect(screen.queryByRole("button", { name: "저장" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== "POST")).toBe(true);
  });

  it("다시 시도가 성공하면 서버 데이터로 editor가 복구되고 저장은 비활성이다", async () => {
    let getCalls = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, status: 200, json: async () => ({ terms: [], corrections: [] }) };
      getCalls += 1;
      if (getCalls === 1) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ terms: ["복구됨"], corrections: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<GlossaryClient />);
    fireEvent.click(await screen.findByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("복구됨")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /일반 용어 \(1\)/ })).toBeInTheDocument();
    // Freshly loaded → not dirty → save disabled.
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
  });

  it("저장은 변경이 있을 때만 활성화된다", async () => {
    stubFetch({ initial: { terms: ["기존"], corrections: [] } });
    render(<GlossaryClient />);
    await screen.findByText("기존");
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    const input = screen.getByRole("textbox", { name: "용어 추가" });
    fireEvent.change(input, { target: { value: "새용어" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("변경됨")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "저장" })).toBeEnabled();
  });

  it.each<SaveMode>(["non_ok", "throw"])(
    "저장 %s 실패는 로컬 편집과 변경 상태를 보존한다",
    async (saveMode) => {
      stubFetch({ saveMode });
      render(<GlossaryClient />);
      const input = await screen.findByRole("textbox", { name: "용어 추가" });
      fireEvent.change(input, { target: { value: "보존용어" } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.click(screen.getByRole("button", { name: "저장" }));
      await waitFor(() => expect(screen.getByText(/저장하지 못했어요/)).toBeInTheDocument());
      expect(screen.getByText("보존용어")).toBeInTheDocument();
      expect(screen.getByText("변경됨")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "저장" })).toBeEnabled();
    },
  );

  it("저장 성공은 서버 정규화 결과로 교체하고 저장됨을 표시한다", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ terms: ["정규화됨"], corrections: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ terms: [], corrections: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<GlossaryClient />);
    const input = await screen.findByRole("textbox", { name: "용어 추가" });
    fireEvent.change(input, { target: { value: "입력값" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.getByText("저장됨")).toBeInTheDocument());
    expect(screen.getByText("정규화됨")).toBeInTheDocument();
    expect(screen.queryByText("입력값")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled(); // no longer dirty
  });

  it("탭은 방향키/Home/End로 이동하고 tabpanel 관계를 노출한다", async () => {
    stubFetch();
    render(<GlossaryClient />);
    const termsTab = await screen.findByRole("tab", { name: /일반 용어/ });
    const corrTab = screen.getByRole("tab", { name: /교정쌍/ });
    expect(termsTab).toHaveAttribute("aria-selected", "true");
    expect(termsTab).toHaveAttribute("tabindex", "0");
    expect(corrTab).toHaveAttribute("tabindex", "-1");

    termsTab.focus();
    fireEvent.keyDown(termsTab, { key: "ArrowRight" });
    expect(corrTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", corrTab.id);

    fireEvent.keyDown(corrTab, { key: "Home" });
    expect(termsTab).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(termsTab, { key: "End" });
    expect(corrTab).toHaveAttribute("aria-selected", "true");
  });

  it("탭을 전환해도 두 탭의 draft 입력이 보존된다", async () => {
    stubFetch();
    render(<GlossaryClient />);
    const termInput = await screen.findByRole("textbox", { name: "용어 추가" });
    fireEvent.change(termInput, { target: { value: "임시 용어" } });
    fireEvent.click(screen.getByRole("tab", { name: /교정쌍/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "잘못 인식된 표기(전)" }), { target: { value: "임시 전" } });
    fireEvent.click(screen.getByRole("tab", { name: /일반 용어/ }));
    expect(screen.getByRole("textbox", { name: "용어 추가" })).toHaveValue("임시 용어");
    fireEvent.click(screen.getByRole("tab", { name: /교정쌍/ }));
    expect(screen.getByRole("textbox", { name: "잘못 인식된 표기(전)" })).toHaveValue("임시 전");
  });

  it("320px 교정 입력은 보이는 전/후 라벨과 세로 stack 구조를 가진다", async () => {
    stubFetch();
    render(<GlossaryClient />);
    fireEvent.click(await screen.findByRole("tab", { name: /교정쌍/ }));
    const fromInput = screen.getByRole("textbox", { name: "잘못 인식된 표기(전)" });
    // Labels are visible text, not just aria-labels.
    expect(screen.getByText("잘못 인식된 표기(전)")).toBeInTheDocument();
    expect(screen.getByText("올바른 표기(후)")).toBeInTheDocument();
    // The input group stacks on mobile and only goes single-line at sm+.
    expect(fromInput.closest("label")?.parentElement).toHaveClass("flex-col", "sm:flex-row");
    expect(screen.getByRole("button", { name: "추가" })).toHaveClass("min-h-11");
    expect(screen.getByRole("button", { name: "저장" })).toHaveClass("min-h-11");
  });

  it("긴 교정쌍 결과 행은 truncate 대신 wrap으로 전체를 보여준다", async () => {
    const longFrom = "아주길게인식된잘못된표기".repeat(4);
    const longTo = "정확하게교정된표기".repeat(4);
    stubFetch({ initial: { terms: [], corrections: [{ from: longFrom, to: longTo }] } });
    render(<GlossaryClient />);
    fireEvent.click(await screen.findByRole("tab", { name: /교정쌍/ }));
    expect(screen.getByText(longFrom)).toBeInTheDocument();
    expect(screen.getByText(longTo)).toBeInTheDocument();
    expect(screen.getByText(longFrom).closest("li")?.querySelector(".truncate")).toBeNull();
  });

  it("용어 칩 삭제 버튼은 32px embedded target·접근 이름·인라인 SVG를 가진다", async () => {
    stubFetch({ initial: { terms: ["삭제될용어"], corrections: [] } });
    render(<GlossaryClient />);
    const remove = await screen.findByRole("button", { name: "용어 삭제: 삭제될용어" });
    expect(remove).toHaveClass("h-8", "w-8");
    expect(remove.querySelector("svg")).not.toBeNull();
  });
});

describe("MeetingDetailView — 전체 스크립트 탭", () => {
  it("shows the corrected transcript without the pre-correction notice", () => {
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus()}
        transcript={{ text: "교정된 회의 내용입니다.", corrected: true }}
        segments={[]}
        summary={null}
        hasAudio={false}
      />,
    );
    expect(screen.getByText("교정된 회의 내용입니다.")).toBeInTheDocument();
    expect(screen.queryByText("교정 전 원문 · 자동 전사")).not.toBeInTheDocument();
  });

  it("labels raw output as pre-correction and shows segment timestamps", () => {
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus()}
        transcript={{ text: "안녕하세요", corrected: false }}
        segments={[{ start: 0, end: 2.4, text: "안녕하세요, 오늘 회의를 시작하겠습니다." }]}
        summary={null}
        hasAudio={false}
      />,
    );
    expect(screen.getByText("교정 전 원문 · 자동 전사")).toBeInTheDocument();
    expect(screen.getByText("안녕하세요, 오늘 회의를 시작하겠습니다.")).toBeInTheDocument();
    expect(screen.getByText("00:00")).toBeInTheDocument();
  });
});

describe("MeetingDetailView — 회의록 요약 탭", () => {
  it("renders the summary sections", () => {
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "회의록 요약" }));
    expect(screen.getByText("한 줄 요약입니다.")).toBeInTheDocument();
    expect(screen.getByText("온보딩을 최우선으로 진행한다.")).toBeInTheDocument();
    expect(screen.getByText("딜런 — 초안 작성 (기한: 2026-07-08)")).toBeInTheDocument();
  });

  it("shows the no-summary notice without terminal commands", () => {
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus()}
        transcript={{ text: "본문", corrected: false }}
        segments={[]}
        summary={null}
        hasAudio={false}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "회의록 요약" }));
    expect(screen.getByText(/아직 요약이 없습니다/)).toBeInTheDocument();
    expect(screen.queryByText(/\/meeting-summarize/)).not.toBeInTheDocument();
  });
});

describe("MeetingDetailView — 요약 상태 카드", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows a spinner label while summarizing", () => {
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarizing" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={null}
        hasAudio={false}
      />,
    );
    expect(screen.getByText("요약 생성 중…")).toBeInTheDocument();
  });

  it("shows the error and a retry button when a summarize failed", () => {
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ error: { message: "모델 응답 오류", action: "retry_summary" } })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={null}
        hasAudio={false}
      />,
    );
    expect(screen.getByText(/모델 응답 오류/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "재시도" })).toBeInTheDocument();
  });

  it("renders the export toolbar once summarized", () => {
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
        content={stableContent()}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "회의록 요약" }));
    expect(screen.getByRole("button", { name: "요약 복사" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "회의록 다운로드(.md)" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "JSON 다운로드" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "폴더 열기" })).toBeInTheDocument();
  });

  it("configured but unavailable model does not show automatic summarizing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/settings/llm/health") {
          return {
            ok: true,
            json: async () => ({ configured: true, provider: "ollama", ok: false, detail: "Ollama model not set" }),
          };
        }
        return { ok: true, json: async () => ({ connected: true, ready: true, model: "base" }) };
      }),
    );
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "transcribed" })}
        transcript={{ text: "본문", corrected: false }}
        segments={[]}
        summary={null}
        hasAudio={false}
      />,
    );
    await waitFor(() => expect(screen.getByText(/요약 모델을 확인하세요/)).toBeInTheDocument());
    expect(screen.queryByText(/요약 대기 · 자동 생성 중/)).not.toBeInTheDocument();
  });
});

describe("MeetingDetailView — information hierarchy and review freshness", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("orders metadata, notices, actions, meeting info, and tabs without putting status in the action group", () => {
    const { container } = render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({
          status: "summarized",
          error: { message: "이전 요약 보존", action: "retry_summary" },
        })}
        transcript={{ text: "매우 긴 전사 ".repeat(500), corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio
        content={stableContent()}
      />,
    );

    const order = Array.from(container.querySelectorAll("main > [data-detail-section]"))
      .map((element) => element.getAttribute("data-detail-section"));
    expect(order).toEqual(["heading", "notices", "actions", "meeting-info", "tabs"]);

    const actions = screen.getByRole("group", { name: "회의 작업" });
    expect(within(actions).getByRole("button", { name: "폴더 열기" })).toBeInTheDocument();
    expect(within(actions).getByRole("link", { name: "회의록 다운로드(.md)" })).toBeInTheDocument();
    expect(within(actions).queryByRole("button", { name: /복사|수정|다시 만들기/ })).not.toBeInTheDocument();
    expect(within(actions).queryByRole("link", { name: /JSON/ })).not.toBeInTheDocument();
    expect(within(actions).queryByText("요약 완료")).not.toBeInTheDocument();

    const actionControls = [
      ...within(actions).getAllByRole("button"),
      ...within(actions).getAllByRole("link"),
    ];
    for (const control of actionControls) {
      expect(control.className).toContain("min-h-11");
      expect(control.className).toContain("rounded-md");
    }

    const info = screen.getByRole("region", { name: "회의 정보" });
    const tabs = screen.getByRole("tablist", { name: "회의 내용" });
    expect(info.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(info).getByText("녹음 재생")).toBeInTheDocument();
    expect(within(info).getByRole("heading", { name: "참석자" })).toBeInTheDocument();
  });

  it("shows a review save error, preserves the typed value, and does the same for a network failure", async () => {
    let reviewAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/api/meetings/m1/review") {
        reviewAttempts += 1;
        if (reviewAttempts === 1) {
          return new Response(JSON.stringify({ error: { code: "internal_error" } }), { status: 500 });
        }
        throw new Error("network unavailable");
      }
      return healthResponse(input);
    }));
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
        content={stableContent()}
      />,
    );
    const input = screen.getByRole("textbox", { name: "참석자" });
    fireEvent.change(input, { target: { value: "딜런, 지훈" } });

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("저장하지 못했습니다"));
    expect(input).toHaveValue("딜런, 지훈");

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(reviewAttempts).toBe(2));
    expect(screen.getByRole("status")).toHaveTextContent("저장하지 못했습니다");
    expect(input).toHaveValue("딜런, 지훈");
  });

  it("uses validated normalized participants for summary copy immediately after save", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/api/meetings/m1/review") {
        return new Response(JSON.stringify({ review: { participants: ["딜런", "지훈"] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return healthResponse(input);
    }));
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "참석자" }), {
      target: { value: " 딜런, 지훈 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("저장됨"));

    fireEvent.click(screen.getByRole("tab", { name: "회의록 요약" }));
    fireEvent.click(screen.getByRole("button", { name: "요약 복사" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls.at(-1)?.[0]).toContain("**참석자:** 딜런, 지훈");
  });

  it("surfaces immediate reveal refusal and network failure instead of claiming the OS viewer opened", async () => {
    let revealAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/api/meetings/m1/reveal") {
        revealAttempts += 1;
        if (revealAttempts === 1) return new Response(null, { status: 500 });
        throw new Error("network unavailable");
      }
      return healthResponse(input);
    }));
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "폴더 열기" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "열기 실패" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "열기 실패" }));
    await waitFor(() => expect(revealAttempts).toBe(2));
    expect(screen.getByRole("button", { name: "열기 실패" })).toBeInTheDocument();
    expect(screen.queryByText("폴더 열림")).not.toBeInTheDocument();
  });

  it("describes a successful reveal response as a detached request, not guaranteed viewer success", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/api/meetings/m1/reveal") return new Response(null, { status: 200 });
      return healthResponse(input);
    }));
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "폴더 열기" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "열기 요청됨" })).toBeInTheDocument());
  });

  it("keeps a dirty participant edit across parent refresh but syncs a pristine field", () => {
    const baseProps = {
      id: "m1",
      transcript: { text: "본문", corrected: true },
      segments: [] as never[],
      summary: SUMMARY,
      hasAudio: false,
    };
    const { rerender } = render(
      <MeetingDetailView {...baseProps} status={makeStatus({
        status: "summarized",
        review: { participants: ["기존"] },
      })} />,
    );
    const input = screen.getByRole("textbox", { name: "참석자" });
    fireEvent.change(input, { target: { value: "작성 중" } });
    rerender(
      <MeetingDetailView {...baseProps} status={makeStatus({
        status: "summarized",
        review: { participants: ["서버 갱신"] },
      })} />,
    );
    expect(input).toHaveValue("작성 중");

    const { rerender: rerenderPristine } = render(
      <MeetingDetailView {...baseProps} id="m2" status={makeStatus({
        id: "m2",
        status: "summarized",
        review: { participants: ["처음"] },
      })} />,
    );
    const pristine = screen.getAllByRole("textbox", { name: "참석자" })[1];
    rerenderPristine(
      <MeetingDetailView {...baseProps} id="m2" status={makeStatus({
        id: "m2",
        status: "summarized",
        review: { participants: ["새 값"] },
      })} />,
    );
    expect(pristine).toHaveValue("새 값");
  });
});

describe("MeetingDetailView — content action hierarchy and manual editing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("global에는 이동·폴더·combined Markdown만, 각 content action은 해당 tab footer에만 둔다", () => {
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
        content={stableContent()}
      />,
    );

    const global = screen.getByRole("group", { name: "회의 작업" });
    expect(within(global).getByRole("button", { name: "폴더 열기" })).toBeInTheDocument();
    expect(within(global).getByRole("link", { name: "회의록 다운로드(.md)" })).toHaveAttribute(
      "href",
      "/api/meetings/m1/export?fmt=md",
    );
    expect(within(global).queryByRole("button", { name: /복사|수정|다시 만들기/ })).not.toBeInTheDocument();
    expect(within(global).queryByRole("link", { name: /JSON/ })).not.toBeInTheDocument();

    const script = screen.getByRole("group", { name: "전체 스크립트 작업" });
    expect(within(script).getByRole("button", { name: "전체 스크립트 복사" })).toBeInTheDocument();
    expect(within(script).getByRole("button", { name: "전체 스크립트 수정" })).toBeInTheDocument();
    expect(within(script).getByRole("button", { name: "원문에서 스크립트 다시 만들기" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "회의록 요약" }));
    const summary = screen.getByRole("group", { name: "회의록 요약 작업" });
    expect(within(summary).getByRole("button", { name: "요약 복사" })).toBeInTheDocument();
    expect(within(summary).getByRole("link", { name: "JSON 다운로드" })).toBeInTheDocument();
    expect(within(summary).getByRole("button", { name: "회의록 요약 수정" })).toBeInTheDocument();
    expect(within(summary).getByRole("button", { name: "현재 스크립트로 요약 다시 만들기" })).toBeInTheDocument();
  });

  it("dirty editor에서 다른 탭 editor를 열면 현재 탭에 discard 확인을 보이고 계속 수정 focus를 복구한다", () => {
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
        content={stableContent()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 수정" }));
    expect(screen.getByRole("textbox", { name: "전체 스크립트" })).toHaveFocus();
    fireEvent.change(screen.getByRole("textbox", { name: "전체 스크립트" }), {
      target: { value: "저장하지 않은 스크립트" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "회의록 요약" }));
    fireEvent.click(screen.getByRole("button", { name: "회의록 요약 수정" }));

    expect(screen.getByText("저장하지 않은 수정 내용을 버릴까요?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "계속 수정" }));
    expect(screen.getByRole("tab", { name: "전체 스크립트" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox", { name: "전체 스크립트" })).toHaveValue("저장하지 않은 스크립트");
    expect(screen.getByRole("textbox", { name: "전체 스크립트" })).toHaveFocus();

    fireEvent.click(screen.getByRole("tab", { name: "회의록 요약" }));
    fireEvent.click(screen.getByRole("button", { name: "회의록 요약 수정" }));
    fireEvent.click(screen.getByRole("button", { name: "수정 내용 버리기" }));
    expect(screen.queryByRole("textbox", { name: "전체 스크립트" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "한 줄 요약" })).toHaveFocus();
  });

  it("pristine third revision은 content probe가 canonical revision을 확인하지 못하면 기존 snapshot과 경고를 유지한다", async () => {
    const thirdRevision = {
      transcriptSha256: "c".repeat(64),
      summarySha256: "d".repeat(64),
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/api/meetings/m1/content") {
        return new Response(JSON.stringify({
          transcript: "본문",
          summary: editableSummary(),
          revision: PAIR_REVISION,
          transcriptSource: "generated",
          summarySource: "generated",
          summaryOutdated: false,
          pairState: "stable",
        }), { headers: { "content-type": "application/json" } });
      }
      return healthResponse(input);
    }));
    const baseProps = {
      id: "m1",
      status: makeStatus({ status: "summarized" }),
      segments: [] as never[],
      hasAudio: false,
    };
    const { rerender } = render(
      <MeetingDetailView
        {...baseProps}
        transcript={{ text: "본문", corrected: true }}
        summary={SUMMARY}
        content={stableContent()}
      />,
    );

    rerender(
      <MeetingDetailView
        {...baseProps}
        transcript={{ text: "확인되지 않은 새 본문", corrected: true }}
        summary={{ ...SUMMARY, oneLine: "확인되지 않은 새 요약" }}
        content={stableContent({ revision: thirdRevision })}
      />,
    );

    expect(await screen.findByText("새 내용의 현재 revision을 확인하지 못해 확인된 내용을 유지했습니다."))
      .toBeInTheDocument();
    expect(screen.getByText("본문")).toBeInTheDocument();
    expect(screen.queryByText("확인되지 않은 새 본문")).not.toBeInTheDocument();
  });

  it("pristine third revision은 content probe가 같은 canonical revision을 확인한 뒤에만 반영한다", async () => {
    const thirdRevision = {
      transcriptSha256: "c".repeat(64),
      summarySha256: "d".repeat(64),
    };
    const thirdSummary = { ...SUMMARY, oneLine: "확인된 새 요약" };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/api/meetings/m1/content") {
        return new Response(JSON.stringify(contentResource({
          transcript: "확인된 새 본문",
          summary: editableSummary(thirdSummary),
          revision: thirdRevision,
          transcriptSource: "manual",
          summarySource: "manual",
        })), { headers: { "content-type": "application/json" } });
      }
      return healthResponse(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    const baseProps = {
      id: "m1",
      status: makeStatus({ status: "summarized" }),
      segments: [] as never[],
      hasAudio: false,
    };
    const { rerender } = render(
      <MeetingDetailView
        {...baseProps}
        transcript={{ text: "본문", corrected: true }}
        summary={SUMMARY}
        content={stableContent()}
      />,
    );

    rerender(
      <MeetingDetailView
        {...baseProps}
        transcript={{ text: "확인된 새 본문", corrected: true }}
        summary={thirdSummary}
        content={stableContent({
          revision: thirdRevision,
          transcriptSource: "manual",
          summarySource: "manual",
        })}
      />,
    );

    expect(await screen.findByText("확인된 새 본문")).toBeInTheDocument();
    expect(screen.getByText("다른 곳에서 저장된 최신 내용을 반영했습니다.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/meetings/m1/content"))
      .toHaveLength(1);
  });

  it("dirty editor는 third revision props와 parent refresh에도 draft를 유지하고 probe를 미룬다", async () => {
    const thirdRevision = {
      transcriptSha256: "c".repeat(64),
      summarySha256: "d".repeat(64),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => healthResponse(input));
    vi.stubGlobal("fetch", fetchMock);
    const baseProps = {
      id: "m1",
      status: makeStatus({ status: "summarized" }),
      segments: [] as never[],
      hasAudio: false,
    };
    const { rerender } = render(
      <MeetingDetailView
        {...baseProps}
        transcript={{ text: "본문", corrected: true }}
        summary={SUMMARY}
        content={stableContent()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "전체 스크립트" }), {
      target: { value: "보존할 dirty draft" },
    });

    rerender(
      <MeetingDetailView
        {...baseProps}
        transcript={{ text: "외부 새 본문", corrected: true }}
        summary={{ ...SUMMARY, oneLine: "외부 새 요약" }}
        content={stableContent({ revision: thirdRevision })}
      />,
    );

    expect(await screen.findByText(/다른 내용 변경이 감지됐지만 현재 입력은 그대로 유지했습니다/))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "전체 스크립트" })).toHaveValue("보존할 dirty draft");
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/meetings/m1/content"))
      .toHaveLength(0);
  });

  it.each([
    ["raw fallback", { state: "missing", revision: null, transcriptSource: null, summarySource: null, summaryOutdated: null }],
    ["ambiguous", { state: "ambiguous", revision: null, transcriptSource: null, summarySource: null, summaryOutdated: null }],
    ["source conflict", { state: "source_conflict", revision: null, transcriptSource: null, summarySource: null, summaryOutdated: null }],
  ] as const)("%s에는 edit/generation mutation action을 노출하지 않는다", (_label, content) => {
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "자동 전사", corrected: false }}
        segments={[]}
        summary={null}
        hasAudio={false}
        content={content}
      />,
    );
    expect(screen.queryByRole("button", { name: /수정|다시 만들기/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "폴더 열기" })).toBeInTheDocument();
  });

  it("transcript PATCH 성공은 revision·본문·outdated 경고·복사 source를 즉시 갱신한다", async () => {
    const nextRevision = {
      transcriptSha256: "c".repeat(64),
      summarySha256: PAIR_REVISION.summarySha256,
    };
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/meetings/m1/transcript") {
        return new Response(JSON.stringify({
          transcript: "수정한\n본문",
          summary: editableSummary(),
          revision: nextRevision,
          transcriptSource: "manual",
          summarySource: "generated",
          summaryOutdated: true,
          pairState: "stable",
          durability: "durable",
        }), { headers: { "content-type": "application/json" } });
      }
      return healthResponse(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
        content={stableContent()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "전체 스크립트" }), {
      target: { value: "수정한\r\n본문" },
    });
    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 저장" }));

    await waitFor(() => expect(screen.getByText(/수정한\s+본문/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/meetings/m1/transcript",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ expectedRevision: PAIR_REVISION, transcript: "수정한\n본문" }),
      }),
    );
    expect(screen.getByRole("tab", { name: /회의록 요약.*요약 갱신 필요/ })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/meetings/m1/content"))
      .toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 복사" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("수정한\n본문"));
  });

  it("summary PATCH는 모든 editable field와 multiline item만 보내고 view·copy freshness를 즉시 갱신한다", async () => {
    const nextRevision = {
      transcriptSha256: PAIR_REVISION.transcriptSha256,
      summarySha256: "d".repeat(64),
    };
    const nextSummary = {
      oneLine: "새 한 줄 요약",
      purpose: "새 목적",
      highlights: ["여러 줄 핵심\n둘째 줄", "추가 핵심"],
      discussion: ["새 논의"],
      decisions: ["새 결정"],
      actionItems: [{ owner: "지훈", task: "검토", due: "2026-07-22" }],
      risks: ["새 리스크"],
      followups: ["새 후속"],
    };
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    let summaryRequest: RequestInit | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "/api/meetings/m1/summary") {
        summaryRequest = init;
        return new Response(JSON.stringify({
          transcript: "본문",
          summary: nextSummary,
          revision: nextRevision,
          transcriptSource: "generated",
          summarySource: "manual",
          summaryOutdated: false,
          pairState: "stable",
          durability: "durable",
        }), { headers: { "content-type": "application/json" } });
      }
      return healthResponse(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
        content={stableContent({ summaryOutdated: true })}
        initialTab="summary"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "회의록 요약 수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "한 줄 요약" }), {
      target: { value: nextSummary.oneLine },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "목적" }), {
      target: { value: nextSummary.purpose },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "핵심 1" }), {
      target: { value: nextSummary.highlights[0] },
    });
    fireEvent.click(screen.getByRole("button", { name: "핵심 추가" }));
    fireEvent.change(screen.getByRole("textbox", { name: "핵심 2" }), {
      target: { value: nextSummary.highlights[1] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "논의 내용 1" }), {
      target: { value: nextSummary.discussion[0] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "결정 사항 1" }), {
      target: { value: nextSummary.decisions[0] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "액션 아이템 1 담당자" }), {
      target: { value: nextSummary.actionItems[0].owner },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "액션 아이템 1 할 일" }), {
      target: { value: nextSummary.actionItems[0].task },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "액션 아이템 1 기한" }), {
      target: { value: nextSummary.actionItems[0].due },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "리스크 1" }), {
      target: { value: nextSummary.risks[0] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "후속 확인 1" }), {
      target: { value: nextSummary.followups[0] },
    });
    fireEvent.click(screen.getByRole("button", { name: "회의록 요약 저장" }));

    await waitFor(() => expect(screen.getByText("새 한 줄 요약")).toBeInTheDocument());
    const body = JSON.parse(String(summaryRequest?.body));
    expect(body).toEqual({ expectedRevision: PAIR_REVISION, summary: nextSummary });
    expect(body.summary).not.toHaveProperty("title");
    expect(body.summary).not.toHaveProperty("topicSlug");
    expect(body.summary).not.toHaveProperty("participants");
    expect(screen.getByRole("tab", { name: "회의록 요약" })).toBeInTheDocument();
    expect(screen.queryByText("요약 갱신 필요")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "요약 복사" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls.at(-1)?.[0]).toContain("새 한 줄 요약");
    expect(writeText.mock.calls.at(-1)?.[0]).toContain("여러 줄 핵심\n둘째 줄");
  });

  it("network 오류는 확정 실패나 PATCH 재전송 대신 한 번 GET probe해 intended save를 확정한다", async () => {
    const nextRevision = {
      transcriptSha256: "c".repeat(64),
      summarySha256: PAIR_REVISION.summarySha256,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/meetings/m1/transcript" && init?.method === "PATCH") {
        throw new Error("connection reset after commit");
      }
      if (url === "/api/meetings/m1/content") {
        return new Response(JSON.stringify({
          transcript: "probe로 확인한 본문",
          summary: editableSummary(),
          revision: nextRevision,
          transcriptSource: "manual",
          summarySource: "generated",
          summaryOutdated: true,
          pairState: "stable",
        }), { headers: { "content-type": "application/json" } });
      }
      return healthResponse(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
        content={stableContent()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "전체 스크립트" }), {
      target: { value: "probe로 확인한 본문" },
    });
    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 저장" }));

    await waitFor(() => expect(screen.getByText("probe로 확인한 본문")).toBeInTheDocument());
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/meetings/m1/transcript")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/meetings/m1/content")).toHaveLength(1);
  });

  it("invalid 2xx 뒤 probe가 old revision이면 not-saved로 확정하고 같은 draft의 수동 재시도를 연다", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/meetings/m1/transcript") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/meetings/m1/content") {
        return new Response(JSON.stringify(contentResource()), {
          headers: { "content-type": "application/json" },
        });
      }
      return healthResponse(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
        content={stableContent()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "전체 스크립트" }), {
      target: { value: "아직 저장되지 않은 draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 저장" }));

    expect(await screen.findByText("저장되지 않은 것을 확인했습니다. 입력을 유지했으니 다시 저장할 수 있습니다."))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "전체 스크립트" })).toHaveValue("아직 저장되지 않은 draft");
    expect(screen.getByRole("textbox", { name: "전체 스크립트" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "전체 스크립트 저장" })).toBeEnabled();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/meetings/m1/transcript")).toHaveLength(1);
  });

  it("probe의 third revision은 conflict로 판정해 draft copy와 confirm-before-latest를 제공한다", async () => {
    const thirdRevision = {
      transcriptSha256: "c".repeat(64),
      summarySha256: PAIR_REVISION.summarySha256,
    };
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/meetings/m1/transcript") throw new Error("unknown commit state");
      if (url === "/api/meetings/m1/content") {
        return new Response(JSON.stringify(contentResource({
          transcript: "다른 곳에서 저장한 본문",
          revision: thirdRevision,
          transcriptSource: "manual",
        })), { headers: { "content-type": "application/json" } });
      }
      return healthResponse(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
        content={stableContent()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "전체 스크립트" }), {
      target: { value: "내 충돌 draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 저장" }));

    expect(await screen.findByText(/다른 변경이 먼저 저장됐습니다/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "전체 스크립트" })).toHaveValue("내 충돌 draft");
    fireEvent.click(screen.getByRole("button", { name: "내 입력 복사" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("내 충돌 draft"));
    fireEvent.click(screen.getByRole("button", { name: "최신 내용 불러오기" }));
    expect(screen.getByText("현재 입력을 버리고 서버에서 확인한 최신 내용으로 교체합니다."))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "최신 내용으로 교체" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/meetings/m1/transcript")).toHaveLength(1);
  });

  it("probe unavailable은 ambiguous로 남겨 draft를 보존하고 PATCH 자동 재전송을 막는다", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/meetings/m1/transcript") {
        return new Response(JSON.stringify({ malformed: true }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/meetings/m1/content") return new Response(null, { status: 503 });
      return healthResponse(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
        content={stableContent()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "전체 스크립트" }), {
      target: { value: "확인 불가 draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 저장" }));

    expect(await screen.findByText("저장 여부를 확인할 수 없습니다. 입력을 유지했으며 저장 요청을 다시 보내지 않았습니다."))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "전체 스크립트" })).toHaveValue("확인 불가 draft");
    expect(screen.getByRole("button", { name: "전체 스크립트 저장" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "수정 취소" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "내 입력 복사" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/meetings/m1/transcript")).toHaveLength(1);
  });

  it("durability pending은 committed warning으로 editor를 닫고 같은 PATCH를 다시 보내지 않는다", async () => {
    const nextRevision = {
      transcriptSha256: "c".repeat(64),
      summarySha256: PAIR_REVISION.summarySha256,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/api/meetings/m1/transcript") {
        return new Response(JSON.stringify(contentResource({
          transcript: "pending 저장 본문",
          revision: nextRevision,
          transcriptSource: "manual",
          summaryOutdated: true,
          durability: "pending",
        })), { headers: { "content-type": "application/json" } });
      }
      return healthResponse(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
        content={stableContent()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "전체 스크립트" }), {
      target: { value: "pending 저장 본문" },
    });
    fireEvent.click(screen.getByRole("button", { name: "전체 스크립트 저장" }));

    expect(await screen.findByText("저장됨 · 디스크 동기화 확인 대기")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "전체 스크립트" })).not.toBeInTheDocument();
    expect(screen.getByText("pending 저장 본문")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/meetings/m1/transcript")).toHaveLength(1);
  });

  it("summaryOutdated를 label/panel/copy에 표시하고 JSON schema 대신 UI help에 연결한다", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
        content={stableContent({ summaryOutdated: true })}
      />,
    );
    const tab = screen.getByRole("tab", { name: /회의록 요약.*요약 갱신 필요/ });
    fireEvent.click(tab);
    expect(screen.getByText("전체 스크립트가 변경되었지만 기존 요약은 유지됨")).toBeInTheDocument();
    const json = screen.getByRole("link", { name: "JSON 다운로드" });
    expect(json).toHaveAttribute("aria-describedby", expect.stringContaining("outdated"));
    fireEvent.click(screen.getByRole("button", { name: "요약 복사" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls.at(-1)?.[0]).toContain("현재 스크립트 변경 후 회의록 요약이 갱신되지 않음");
  });

  it("두 regeneration dialog는 exact endpoint/body를 쓰고 Cancel에 initial focus를 둔다", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/regenerate") || String(input).includes("/summarize")) {
        return new Response(JSON.stringify({ ok: true, durability: "durable" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      return healthResponse(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
        content={stableContent()}
      />,
    );

    const transcriptTrigger = screen.getByRole("button", { name: "원문에서 스크립트 다시 만들기" });
    fireEvent.click(transcriptTrigger);
    expect(screen.getByRole("button", { name: "취소" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "스크립트 다시 만들기" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/meetings/m1/transcript/regenerate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expectedRevision: PAIR_REVISION, confirmReplacement: true }),
      }),
    ));
  });
});

describe("SettingsForm — persisted draft/load/test state", () => {
  afterEach(() => vi.unstubAllGlobals());

  type SettingsBody = {
    provider: "claude-cli" | "codex-cli" | "ollama" | null;
    model?: string;
    baseUrl?: string;
  };

  function stubSettings(options: {
    initial?: SettingsBody;
    getMode?: "ok" | "non_ok" | "throw" | "invalid";
    saveMode?: "ok" | "non_ok" | "throw";
    healthMode?: "ok" | "non_ok" | "throw" | "invalid";
    saved?: SettingsBody;
    health?: LlmHealthState;
  } = {}) {
    const {
      initial = { provider: null },
      getMode = "ok",
      saveMode = "ok",
      healthMode = "ok",
      saved,
      health = { configured: false },
    } = options;
    const posted: unknown[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/settings/llm/health") {
        if (healthMode === "throw") throw new Error("network");
        if (healthMode === "non_ok") return { ok: false, status: 503, json: async () => ({}) };
        if (healthMode === "invalid") return { ok: true, status: 200, json: async () => ({ configured: true }) };
        return { ok: true, status: 200, json: async () => health };
      }
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posted.push(body);
        if (saveMode === "throw") throw new Error("network");
        if (saveMode === "non_ok") {
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: { code: "invalid_request", details: { field: "model" } } }),
          };
        }
        return { ok: true, status: 200, json: async () => saved ?? body };
      }
      if (getMode === "throw") throw new Error("network");
      if (getMode === "non_ok") return { ok: false, status: 500, json: async () => ({}) };
      if (getMode === "invalid") return { ok: true, status: 200, json: async () => ({ provider: "remote-api" }) };
      return { ok: true, status: 200, json: async () => initial };
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, posted };
  }

  it.each(["throw", "non_ok", "invalid"] as const)(
    "GET %s 실패는 기본 Claude 설정으로 낮추지 않고 저장을 잠근다",
    async (getMode) => {
      const { fetchMock } = stubSettings({ getMode });
      render(<SettingsForm />);
      expect(await screen.findByText(/설정을 불러오지 못했어요/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "저장" })).not.toBeInTheDocument();
      expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
    },
  );

  it("GET provider:null은 명시적 미설정 ready이며 연결 테스트는 저장 전까지 잠긴다", async () => {
    stubSettings();
    render(<SettingsForm />);
    expect(await screen.findByText("저장된 요약 모델 설정이 없습니다.")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "저장" });
    const test = screen.getByRole("button", { name: "연결 테스트" });
    expect(save).toBeEnabled();
    expect(test).toBeDisabled();
    expect(screen.getByRole("main")).toHaveClass("px-4", "py-12", "sm:px-6");
    expect(save.closest("form")).toHaveClass("p-4", "sm:p-6");
    expect(save.parentElement).toHaveClass("flex-wrap");
    expect(save).toHaveClass("min-h-11");
    expect(test).toHaveClass("min-h-11");
    expect(screen.getByText(/먼저 설정을 저장한 뒤 연결을 테스트하세요/)).toBeInTheDocument();
  });

  it("GET 실패 뒤 다시 시도 성공은 서버 snapshot으로 editor를 복구한다", async () => {
    let getCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      getCalls += 1;
      if (getCalls === 1) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ provider: "codex-cli", model: "gpt-5" }) };
    }));
    render(<SettingsForm />);
    fireEvent.click(await screen.findByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("textbox", { name: /모델/ })).toHaveValue("gpt-5");
    expect(screen.getByLabelText(/Codex CLI/)).toBeChecked();
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "연결 테스트" })).toBeEnabled();
  });

  it("saved snapshot과 같은 draft는 저장이 잠기고 변경하면 저장만 활성화된다", async () => {
    stubSettings({ initial: { provider: "claude-cli", model: "sonnet" } });
    render(<SettingsForm />);
    const model = await screen.findByRole("textbox", { name: /모델/ });
    expect(model).toHaveValue("sonnet");
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "연결 테스트" })).toBeEnabled();

    fireEvent.change(model, { target: { value: "opus" } });
    expect(screen.getByRole("button", { name: "저장" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "연결 테스트" })).toBeDisabled();
    expect(screen.getByText(/변경 사항을 먼저 저장하세요/)).toBeInTheDocument();
  });

  it("save success는 서버 정규화 snapshot으로 draft를 맞추고 연결 테스트를 연다", async () => {
    const { posted } = stubSettings({
      saved: { provider: "ollama", model: "llama3.1", baseUrl: "http://127.0.0.1:11434" },
    });
    render(<SettingsForm />);
    await screen.findByText("저장된 요약 모델 설정이 없습니다.");
    fireEvent.click(screen.getByLabelText(/Ollama/));
    fireEvent.change(screen.getByRole("textbox", { name: /모델/ }), { target: { value: " llama3.1 " } });
    fireEvent.change(screen.getByRole("textbox", { name: /Base URL/ }), {
      target: { value: " http://127.0.0.1:11434 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(screen.getByText("저장됨")).toBeInTheDocument());
    expect(posted[0]).toEqual({
      provider: "ollama",
      model: "llama3.1",
      baseUrl: "http://127.0.0.1:11434",
    });
    expect(screen.getByRole("textbox", { name: /모델/ })).toHaveValue("llama3.1");
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "연결 테스트" })).toBeEnabled();
  });

  it("save 진행 중에는 persisted test를 잠그고 저장 완료를 기다리라는 이유를 표시한다", async () => {
    let finishSave: ((value: { ok: boolean; status: number; json(): Promise<SettingsBody> }) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Promise<{ ok: boolean; status: number; json(): Promise<SettingsBody> }>((resolve) => {
          finishSave = resolve;
        });
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ provider: "claude-cli", model: "sonnet" } as SettingsBody),
      };
    }));
    render(<SettingsForm />);
    const model = await screen.findByRole("textbox", { name: /모델/ });
    fireEvent.change(model, { target: { value: "opus" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(screen.getByRole("button", { name: "저장 중…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "연결 테스트" })).toBeDisabled();
    expect(screen.getByText("설정 저장이 끝난 뒤 연결을 테스트할 수 있습니다.")).toBeInTheDocument();

    await act(async () => finishSave?.({
      ok: true,
      status: 200,
      json: async () => ({ provider: "claude-cli", model: "opus" }),
    }));
    expect(await screen.findByText("저장됨")).toBeInTheDocument();
  });

  it.each(["non_ok", "throw"] as const)("save %s 실패는 draft와 dirty를 보존한다", async (saveMode) => {
    stubSettings({ initial: { provider: "claude-cli", model: "sonnet" }, saveMode });
    render(<SettingsForm />);
    const model = await screen.findByRole("textbox", { name: /모델/ });
    fireEvent.change(model, { target: { value: "draft-model" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/저장하지 못했어요/));
    expect(model).toHaveValue("draft-model");
    expect(screen.getByRole("button", { name: "저장" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "연결 테스트" })).toBeDisabled();
  });

  it("Ollama 선택 직후에는 neutral helper만 보이고 blur 뒤 field error를 연결한다", async () => {
    stubSettings();
    render(<SettingsForm />);
    await screen.findByText("저장된 요약 모델 설정이 없습니다.");
    fireEvent.click(screen.getByLabelText(/Ollama/));
    const model = screen.getByRole("textbox", { name: /모델/ });
    expect(screen.getByText("모델명이 필요합니다.")).toBeInTheDocument();
    expect(screen.queryByText("Ollama 모델명을 입력하세요.")).not.toBeInTheDocument();
    expect(model).not.toHaveAttribute("aria-invalid", "true");

    fireEvent.blur(model);
    expect(screen.getByText("Ollama 모델명을 입력하세요.")).toBeInTheDocument();
    expect(model).toHaveAttribute("aria-invalid", "true");
    expect(model).toHaveAttribute("aria-describedby", "settings-model-error");

    fireEvent.click(screen.getByLabelText(/Claude CLI/));
    expect(screen.queryByText("Ollama 모델명을 입력하세요.")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /모델/ })).not.toHaveAttribute("aria-invalid", "true");
  });

  it("connection test는 persisted provider/model snapshot을 표시하고 baseUrl은 노출하지 않는다", async () => {
    stubSettings({
      initial: { provider: "ollama", model: "llama3.1", baseUrl: "http://127.0.0.1:11434" },
      health: { configured: true, provider: "ollama", model: "llama3.1", ok: true, detail: "connected" },
    });
    render(<SettingsForm />);
    const test = await screen.findByRole("button", { name: "연결 테스트" });
    fireEvent.click(test);
    expect(await screen.findByText("검사한 저장 설정: Ollama · llama3.1")).toBeInTheDocument();
    expect(screen.getByText(/Ollama llama3.1 · 연결됨/)).toBeInTheDocument();
    expect(screen.queryByText(/11434/)).not.toBeInTheDocument();
  });

  it.each(["non_ok", "throw", "invalid"] as const)(
    "connection test %s 실패는 저장 snapshot을 기준으로 안전한 오류를 표시한다",
    async (healthMode) => {
      stubSettings({
        initial: { provider: "codex-cli", model: "gpt-5" },
        healthMode,
      });
      render(<SettingsForm />);
      fireEvent.click(await screen.findByRole("button", { name: "연결 테스트" }));
      expect(await screen.findByText(/연결 테스트 요청에 실패했습니다/)).toBeInTheDocument();
      expect(screen.getByText("검사한 저장 설정: Codex CLI · gpt-5")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "연결 테스트" })).toBeEnabled();
    },
  );
});

describe("MeetingDetailView — operation별 재생성", () => {
  afterEach(() => vi.unstubAllGlobals());

  function acceptedGenerationResponse() {
    return new Response(JSON.stringify({ ok: true, durability: "durable" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }

  it("summary generation은 current revision을 보내고 operation 관측·해제로 identical content도 완료한다", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/api/meetings/m1/summarize") return acceptedGenerationResponse();
      return healthResponse(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    const baseStatus = makeStatus({ status: "summarized" });
    const props = {
      id: "m1",
      transcript: { text: "본문", corrected: true },
      segments: [] as never[],
      summary: SUMMARY,
      content: stableContent(),
      hasAudio: false,
    };
    const { rerender } = render(<MeetingDetailView {...props} status={baseStatus} />);
    fireEvent.click(screen.getByRole("tab", { name: "회의록 요약" }));
    fireEvent.click(screen.getByRole("button", { name: "현재 스크립트로 요약 다시 만들기" }));
    fireEvent.click(screen.getByRole("button", { name: "요약 다시 만들기" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/meetings/m1/summarize",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ resummarize: true, expectedRevision: PAIR_REVISION }),
      }),
    ));
    await waitFor(() => expect(screen.getAllByText("요약 만드는 중…").length).toBeGreaterThan(0));

    rerender(
      <MeetingDetailView
        {...props}
        status={{ ...baseStatus, contentOperation: "summary" }}
      />,
    );
    rerender(
      <MeetingDetailView
        {...props}
        status={{ ...baseStatus, contentOperation: null }}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "현재 스크립트로 요약 다시 만들기" })).toBeEnabled();
  });

  it("cold entry operation은 transcript와 summary label을 각 footer에서 구분한다", () => {
    const baseProps = {
      id: "m1",
      transcript: { text: "본문", corrected: true },
      segments: [] as never[],
      summary: SUMMARY,
      content: stableContent({ state: "active" }),
      hasAudio: false,
    };
    const first = render(
      <MeetingDetailView
        {...baseProps}
        status={{ ...makeStatus({ status: "summarized" }), contentOperation: "transcript" }}
      />,
    );
    expect(screen.getByText("전체 스크립트 생성 중")).toBeInTheDocument();
    expect(screen.getByText("스크립트 만드는 중…")).toBeInTheDocument();
    first.unmount();

    render(
      <MeetingDetailView
        {...baseProps}
        initialTab="summary"
        status={{ ...makeStatus({ status: "summarized" }), contentOperation: "summary" }}
      />,
    );
    expect(screen.getByText("회의록 요약 생성 중")).toBeInTheDocument();
    expect(screen.getByText("요약 만드는 중…")).toBeInTheDocument();
  });

  it("operation별 failure는 전용 tab에서 재시도하도록 안내하고 옛 summary를 유지한다", () => {
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({
          status: "summarized",
          error: { message: "스크립트 생성 오류", action: "retry_transcript_generation" },
        })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        content={stableContent()}
        hasAudio={false}
      />,
    );
    expect(screen.getByText(/전체 스크립트 생성 실패/)).toBeInTheDocument();
    expect(screen.getByText(/전체 스크립트 탭 하단/)).toBeInTheDocument();
    expect(screen.queryByText("한 줄 요약입니다.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "회의록 요약" }));
    expect(screen.getByText("한 줄 요약입니다.")).toBeInTheDocument();
  });

  it("summary generation timeout은 기존 내용을 유지하고 dialog를 다시 닫을 수 있게 한다", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
        if (String(input) === "/api/meetings/m1/summarize") return acceptedGenerationResponse();
        return healthResponse(input);
      }));
      render(
        <MeetingDetailView
          id="m1"
          status={makeStatus({ status: "summarized" })}
          transcript={{ text: "본문", corrected: true }}
          segments={[]}
          summary={SUMMARY}
          content={stableContent()}
          hasAudio={false}
          initialTab="summary"
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "현재 스크립트로 요약 다시 만들기" }));
      fireEvent.click(screen.getByRole("button", { name: "요약 다시 만들기" }));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2 * 1_800_000 + 60_000);
      expect(screen.getAllByText(/요약 생성이 시간 내에 끝나지 않았습니다/).length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: "취소" })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stable pair가 없는 최초 transcribed meeting에는 local regeneration action이 없다", () => {
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "transcribed" })}
        transcript={{ text: "본문", corrected: false }}
        segments={[]}
        summary={null}
        content={{
          state: "missing",
          revision: null,
          transcriptSource: null,
          summarySource: null,
          summaryOutdated: null,
        }}
        hasAudio={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /다시 만들기/ })).not.toBeInTheDocument();
  });
});
