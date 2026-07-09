import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmptyState } from "@/components/EmptyState";
import { GlossaryClient } from "@/components/GlossaryClient";
import { MeetingDetailView } from "@/components/MeetingDetailView";
import { MeetingList, type MeetingListItem } from "@/components/MeetingList";
import { PendingBanner } from "@/components/PendingBanner";
import { Recorder } from "@/components/Recorder";
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
});

describe("Recorder — responsive layout", () => {
  it("모바일에서 녹음 버튼이 본문 옆으로 밀어내지 않도록 줄바꿈 class를 가진다", () => {
    render(<Recorder />);
    const heading = screen.getByRole("heading", { name: "회의 녹음" });
    expect(heading.parentElement?.parentElement).toHaveClass("flex-col");
    expect(heading.parentElement?.parentElement).toHaveClass("sm:flex-row");
    expect(screen.getByRole("button", { name: "실시간 기록 시작" })).toHaveClass("w-full");
    expect(screen.getByRole("button", { name: "실시간 기록 시작" })).toHaveClass("sm:w-auto");
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
    expect(screen.getByRole("textbox", { name: /제목/ })).toBeInTheDocument(); // still in edit mode
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
    render(<MeetingList meetings={[meeting()]} onRenamed={vi.fn()} onDeleted={vi.fn()} />);
    expect(screen.getByRole("link", { name: /테스트 회의/ })).toHaveClass("flex-col");
    expect(screen.getByRole("link", { name: /테스트 회의/ })).toHaveClass("sm:flex-row");
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
    expect(screen.getByText("Claude CLI sonnet · 연결됨")).toBeInTheDocument();
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

  it("요약 완료 회의에서 '다시 요약' 확인 시 resummarize를 POST한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
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
