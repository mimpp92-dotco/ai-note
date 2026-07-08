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
  it("renders the guide and the 3-step manual seam", () => {
    render(<EmptyState />);
    expect(screen.getByText("아직 회의록이 없습니다")).toBeInTheDocument();
    expect(screen.getByText(/\/meeting-summarize/)).toBeInTheDocument();
  });
});

describe("PendingBanner", () => {
  it("shows the count and the summarize command when meetings await correction", () => {
    render(<PendingBanner count={2} />);
    expect(screen.getByText("2개 회의 교정 대기")).toBeInTheDocument();
    expect(screen.getByText("/meeting-summarize")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "커맨드 복사" })).toBeInTheDocument();
  });

  it("renders nothing when nothing is pending", () => {
    const { container } = render(<PendingBanner count={0} />);
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

  it("prompts to run /meeting-summarize when there is no summary yet", () => {
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
  });
});
