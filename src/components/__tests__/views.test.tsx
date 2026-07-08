import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EmptyState } from "@/components/EmptyState";
import { MeetingDetailView } from "@/components/MeetingDetailView";
import { PendingBanner } from "@/components/PendingBanner";
import type { StatusJson } from "@/domain/meeting";
import type { Summary } from "@/domain/summary";

// next/link needs the app-router context at runtime; a plain anchor is enough here.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: import("react").ReactNode }) => <a href={href}>{children}</a>,
}));

// MeetingDetailView uses useRouter (refresh polling / retry); stub it for the DOM.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
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
    render(<PendingBanner count={2} configured={false} />);
    expect(screen.getByText("2개 회의가 요약 대기 중")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "설정" })).toBeInTheDocument();
    expect(screen.getByText(/녹음·전사는 모델 없이 동작합니다/)).toBeInTheDocument();
    expect(screen.queryByText(/\/meeting-summarize/)).not.toBeInTheDocument();
  });

  it("shows auto-processing when a model is configured", () => {
    render(<PendingBanner count={2} configured={true} />);
    expect(screen.getByText("2개 회의")).toBeInTheDocument();
    expect(screen.getByText(/요약 자동 처리 중/)).toBeInTheDocument();
  });

  it("renders nothing when nothing is pending", () => {
    const { container } = render(<PendingBanner count={0} configured={false} />);
    expect(container).toBeEmptyDOMElement();
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
});
