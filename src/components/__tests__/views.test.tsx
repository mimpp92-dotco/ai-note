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
