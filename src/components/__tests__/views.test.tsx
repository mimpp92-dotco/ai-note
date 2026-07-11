import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { Sidebar } from "@/components/Sidebar";
import type { LlmHealthState, WhisperHealthState } from "@/components/healthStatus";
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

// MeetingDetailView uses useRouter; Sidebar uses usePathname. navMock.pathname is
// mutable so Sidebar active-state tests can control the current route.
const navMock = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => navMock.pathname,
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

describe("Sidebar — 활성 항목", () => {
  afterEach(() => {
    navMock.pathname = "/";
    vi.unstubAllGlobals();
  });

  const renderSidebar = (
    health: { whisper: WhisperHealthState; llm: LlmHealthState } = {
    whisper: { connected: true, ready: true, model: "base" },
    llm: { configured: true, provider: "claude-cli", model: "sonnet", ok: true, detail: "ready" },
    },
  ) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/whisper/health") return { ok: true, json: async () => health.whisper };
        if (url === "/api/settings/llm/health") return { ok: true, json: async () => health.llm };
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<Sidebar />);
  };

  it("identity, section labels, system rows, settings를 렌더링한다", async () => {
    renderSidebar();
    expect(screen.getByRole("navigation", { name: "주요 메뉴" })).toHaveTextContent("AI NOTE");
    expect(screen.getByText("로컬 회의록")).toBeInTheDocument();
    expect(screen.getByText("주요 메뉴")).toBeInTheDocument();
    expect(screen.getByText("시스템")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /설정/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Whisper base · 준비됨")).toBeInTheDocument());
    expect(screen.getByText("Claude CLI sonnet · 감지됨")).toBeInTheDocument();
  });

  it("모바일 compact 전환을 위한 responsive shell class를 가진다", () => {
    renderSidebar();
    const nav = screen.getByRole("navigation", { name: "주요 메뉴" });
    expect(nav).toHaveClass("w-full");
    expect(nav).toHaveClass("border-b");
    expect(nav).toHaveClass("md:w-60");
    expect(nav).toHaveClass("md:border-r");
  });

  it("홈(/)에서 회의록 관리가 활성", () => {
    navMock.pathname = "/";
    renderSidebar();
    const active = screen.getByRole("link", { name: /회의록 관리/ });
    expect(active).toHaveAttribute("aria-current", "page");
    expect(active.querySelector("[data-active-marker]")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "단어 관리" })).not.toHaveAttribute("aria-current");
  });

  it("상세(/meetings/*)에서도 회의록 관리가 활성", () => {
    navMock.pathname = "/meetings/abc-123";
    renderSidebar();
    expect(screen.getByRole("link", { name: "회의록 관리" })).toHaveAttribute("aria-current", "page");
  });

  it("/glossary에서 단어 관리가 활성", () => {
    navMock.pathname = "/glossary";
    renderSidebar();
    expect(screen.getByRole("link", { name: "단어 관리" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "회의록 관리" })).not.toHaveAttribute("aria-current");
  });

  it("/settings에서 설정이 활성", () => {
    navMock.pathname = "/settings";
    renderSidebar();
    const settings = screen.getByRole("link", { name: /설정/ });
    expect(settings).toHaveAttribute("aria-current", "page");
    expect(settings.querySelector("[data-active-marker]")).toBeInTheDocument();
  });

  it("실패/미설정 시스템 상태는 설정으로 이동 가능한 affordance를 유지한다", async () => {
    renderSidebar({
      whisper: { connected: true, ready: false, model: "large-v3" },
      llm: { configured: false },
    });
    await waitFor(() => expect(screen.getByText("Whisper large-v3 · 준비 중")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /요약.*요약 모델 미설정/ })).toHaveAttribute("href", "/settings");
  });
});

describe("GlossaryClient — 추가/삭제/저장", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(initial = { terms: [] as string[], corrections: [] as { from: string; to: string }[] }) {
    const posted: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posted.push(body);
        return { ok: true, status: 200, json: async () => body };
      }
      return { ok: true, status: 200, json: async () => initial };
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, posted };
  }

  it("일반 용어를 추가하면 칩과 카운트가 늘어난다(공백 분리 안 함)", async () => {
    stubFetch();
    render(<GlossaryClient />);
    const input = screen.getByRole("textbox", { name: "용어 추가" });
    fireEvent.change(input, { target: { value: "프로덕트 로드맵" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("프로덕트 로드맵")).toBeInTheDocument(); // not split on the space
    expect(screen.getByRole("tab", { name: /일반 용어 \(1\)/ })).toBeInTheDocument();
  });

  it("한국어 IME 조합 중 Enter는 일반 용어를 조기 추가하지 않는다", () => {
    stubFetch();
    render(<GlossaryClient />);
    const input = screen.getByRole("textbox", { name: "용어 추가" });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "이창규" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(screen.queryByText("이창규")).not.toBeInTheDocument();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("이창규")).toBeInTheDocument();
    expect(screen.queryByText("규")).not.toBeInTheDocument();
  });

  it("쉼표로 여러 용어를 한 번에 추가한다", () => {
    stubFetch();
    render(<GlossaryClient />);
    const input = screen.getByRole("textbox", { name: "용어 추가" });
    fireEvent.change(input, { target: { value: "OKR, 로드맵, OKR" } }); // dup dropped
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("tab", { name: /일반 용어 \(2\)/ })).toBeInTheDocument();
  });

  it("교정쌍을 추가하고 저장하면 POST 본문에 담긴다", async () => {
    const { posted } = stubFetch();
    render(<GlossaryClient />);
    await waitFor(() => expect(screen.getByRole("button", { name: "저장" })).toBeEnabled());

    fireEvent.click(screen.getByRole("tab", { name: /교정쌍/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "잘못 인식된 표기(전)" }), { target: { value: "김민중" } });
    fireEvent.change(screen.getByRole("textbox", { name: "올바른 표기(후)" }), { target: { value: "김민준" } });
    fireEvent.click(screen.getByRole("button", { name: "추가" }));
    expect(screen.getByRole("tab", { name: /교정쌍 \(1\)/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]).toEqual({ terms: [], corrections: [{ from: "김민중", to: "김민준" }] });
  });

  it("교정쌍은 전·후가 모두 있어야 추가 가능하다", () => {
    stubFetch();
    render(<GlossaryClient />);
    fireEvent.click(screen.getByRole("tab", { name: /교정쌍/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "잘못 인식된 표기(전)" }), { target: { value: "김민중" } });
    expect(screen.getByRole("button", { name: "추가" })).toBeDisabled(); // no "to" yet
  });

  it("한국어 IME 조합 중 Enter는 교정쌍을 조기 추가하지 않는다", () => {
    stubFetch();
    render(<GlossaryClient />);
    fireEvent.click(screen.getByRole("tab", { name: /교정쌍/ }));
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
      />,
    );
    expect(screen.getByRole("button", { name: "요약 복사" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "요약 다운로드(.md)" })).toBeInTheDocument();
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
      />,
    );

    const order = Array.from(container.querySelectorAll("main > [data-detail-section]"))
      .map((element) => element.getAttribute("data-detail-section"));
    expect(order).toEqual(["heading", "notices", "actions", "meeting-info", "tabs"]);

    const actions = screen.getByRole("group", { name: "회의 작업" });
    expect(within(actions).getByRole("button", { name: "요약 복사" })).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: "전사 복사" })).toBeInTheDocument();
    expect(within(actions).getByRole("link", { name: "요약 다운로드(.md)" })).toBeInTheDocument();
    expect(within(actions).getByRole("link", { name: "JSON(.json)" })).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: "폴더 열기" })).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: "다시 요약" })).toBeInTheDocument();
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

describe("SettingsForm — Ollama model validation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Ollama는 모델명이 없으면 저장할 수 없다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ provider: null }),
      })),
    );
    render(<SettingsForm />);
    await waitFor(() => expect(screen.getByRole("button", { name: "저장" })).toBeEnabled());
    fireEvent.click(screen.getByLabelText(/Ollama/));
    expect(screen.getByText("Ollama 모델명을 입력하세요.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
  });
});

describe("MeetingDetailView — 다시 요약", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("요약 완료 회의에서 '다시 요약' 확인 시 resummarize를 202로 POST하고 '요약 중'이 된다", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
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
    fireEvent.click(screen.getByRole("button", { name: "다시 요약" })); // reveal confirm
    fireEvent.click(screen.getByRole("button", { name: "다시 요약" })); // confirm
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/meetings/m1/summarize",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ resummarize: true }) }),
      ),
    );
    // 202 accepted → local "요약 중" while the client polls for the new summary.
    await waitFor(() => expect(screen.getByRole("button", { name: "요약 중…" })).toBeInTheDocument());
  });

  it("재요약이 완료되어 요약 내용이 바뀌면 '요약 중' 상태가 해제된다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 202 }));
    const props = {
      id: "m1",
      status: makeStatus({ status: "summarized" }),
      transcript: { text: "본문", corrected: true },
      segments: [],
      hasAudio: false,
    };
    const { rerender } = render(<MeetingDetailView {...props} summary={SUMMARY} />);
    fireEvent.click(screen.getByRole("button", { name: "다시 요약" })); // reveal
    fireEvent.click(screen.getByRole("button", { name: "다시 요약" })); // confirm → run
    await waitFor(() => expect(screen.getByRole("button", { name: "요약 중…" })).toBeInTheDocument());

    // A server refresh delivers a changed summary → success clears busy, reopens 다시 요약.
    rerender(<MeetingDetailView {...props} summary={{ ...SUMMARY, oneLine: "새로 생성된 요약." }} />);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "요약 중…" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "다시 요약" })).toBeInTheDocument();
  });

  it("재요약 실패 시 '재요약 실패' 배너와 요약/다시 요약을 유지하고 재시도는 resummarize로 POST한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({
          status: "summarized",
          error: { message: "모델 응답 오류", action: "retry_summary" },
        })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
      />,
    );
    // Banner reads "재요약 실패" (not "요약 실패") and shows the message.
    expect(screen.getByText(/재요약 실패/)).toBeInTheDocument();
    expect(screen.getByText(/모델 응답 오류/)).toBeInTheDocument();
    // The prior summary export + 다시 요약 stay available (data not lost).
    expect(screen.getByRole("button", { name: "요약 복사" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 요약" })).toBeInTheDocument();
    // Retry from the banner forces a re-summarize (must send resummarize:true).
    fireEvent.click(screen.getByRole("button", { name: "재시도" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/meetings/m1/summarize",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ resummarize: true }) }),
      ),
    );
  });

  it("실패 상태에서 재시도를 눌러도 옛 retry_summary 에러로 즉시 완료 처리하지 않는다(요약 중 유지)", async () => {
    // Regression guard: a stale pre-run retry_summary error must NOT be read as this
    // run's instant failure. Completion is gated on first observing the in-flight lock.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 202 }));
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({
          status: "summarized",
          error: { message: "이전 실패", action: "retry_summary" },
        })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
        resummarizeInflight={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "재시도" }));
    // Enters the in-progress state (spinner) and STAYS there — the stale error is not
    // read as this run's instant failure, and the banner is replaced by the spinner.
    await waitFor(() => expect(screen.getByText("요약 생성 중…")).toBeInTheDocument());
    expect(screen.queryByText(/재요약 실패/)).not.toBeInTheDocument();
  });

  it("재요약 폴링이 in-flight 락 해제 후 나타난 retry_summary 에러를 실패로 감지한다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 202 }));
    const props = {
      id: "m1",
      transcript: { text: "본문", corrected: true },
      segments: [] as never[],
      hasAudio: false,
      summary: SUMMARY,
    };
    const clean = makeStatus({ status: "summarized" });
    const { rerender } = render(<MeetingDetailView {...props} status={clean} resummarizeInflight={false} />);
    fireEvent.click(screen.getByRole("button", { name: "다시 요약" })); // reveal
    fireEvent.click(screen.getByRole("button", { name: "다시 요약" })); // confirm → 202
    await waitFor(() => expect(screen.getByRole("button", { name: "요약 중…" })).toBeInTheDocument());

    // A poll observes the run holding the lock (content unchanged) → stays busy.
    rerender(<MeetingDetailView {...props} status={clean} resummarizeInflight={true} />);
    expect(screen.getByRole("button", { name: "요약 중…" })).toBeInTheDocument();

    // The run fails: lock clears and a retry_summary error appears (content still same).
    const failed = makeStatus({
      status: "summarized",
      error: { message: "모델 응답 오류", action: "retry_summary" },
    });
    rerender(<MeetingDetailView {...props} status={failed} resummarizeInflight={false} />);

    await waitFor(() => expect(screen.getByText(/재요약 실패/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "요약 중…" })).not.toBeInTheDocument();
  });

  it("재요약이 데드라인을 넘기면 타임아웃 안내를 표시한다", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 202 }));
      render(
        <MeetingDetailView
          id="m1"
          status={makeStatus({ status: "summarized" })}
          transcript={{ text: "본문", corrected: true }}
          segments={[]}
          summary={SUMMARY}
          hasAudio={false}
          resummarizeInflight={false}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "다시 요약" })); // reveal
      fireEvent.click(screen.getByRole("button", { name: "다시 요약" })); // confirm → 202
      await vi.advanceTimersByTimeAsync(0); // flush the 202 microtask

      // No content change and no inflight signal ever arrives → the ceiling fires.
      await vi.advanceTimersByTimeAsync(3 * 600_000 + 60_000);
      expect(screen.getByText(/시간 내에 끝나지 않았어요/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("진행 중에 페이지를 새로 열면(서버 in-flight) 버튼 없이도 '요약 생성 중'으로 보인다", () => {
    // Cold entry: no local click, but the server reports a run in flight. deriveStatus
    // masks status as summarized (old summary.json exists) — the UI must still read busy.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 202 }));
    render(
      <MeetingDetailView
        id="m1"
        status={makeStatus({ status: "summarized" })}
        transcript={{ text: "본문", corrected: true }}
        segments={[]}
        summary={SUMMARY}
        hasAudio={false}
        resummarizeInflight={true}
      />,
    );
    // Status card shows the spinner, and the top badge reads "요약 생성 중".
    expect(screen.getByText("요약 생성 중…")).toBeInTheDocument();
    expect(screen.getAllByText("요약 생성 중").length).toBeGreaterThan(0);
    // "다시 요약" is disabled while a run is in flight (clicking it would 409).
    const button = screen.getByRole("button", { name: "요약 중…" });
    expect(button).toBeDisabled();
  });

  it("서버 in-flight가 해제되고 새 요약이 오면 자동으로 완료 상태가 된다(cold entry)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 202 }));
    const props = {
      id: "m1",
      status: makeStatus({ status: "summarized" }),
      transcript: { text: "본문", corrected: true },
      segments: [] as never[],
      hasAudio: false,
    };
    const { rerender } = render(
      <MeetingDetailView {...props} summary={SUMMARY} resummarizeInflight={true} />,
    );
    expect(screen.getByText("요약 생성 중…")).toBeInTheDocument();

    // The run finishes: lock clears and a new summary arrives via a server refresh.
    rerender(
      <MeetingDetailView
        {...props}
        summary={{ ...SUMMARY, oneLine: "새로 생성된 요약." }}
        resummarizeInflight={false}
      />,
    );
    await waitFor(() => expect(screen.queryByText("요약 생성 중…")).not.toBeInTheDocument());
    // Back to a normal summarized view with the re-summarize button enabled.
    expect(screen.getByRole("button", { name: "다시 요약" })).toBeEnabled();
  });

  it("아직 요약되지 않은 회의에는 '다시 요약' 버튼이 없다", () => {
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
    expect(screen.queryByRole("button", { name: "다시 요약" })).not.toBeInTheDocument();
  });
});
