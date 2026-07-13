import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MeetingDetailView } from "@/components/MeetingDetailView";
import { MeetingList } from "@/components/MeetingList";
import type { StatusJson } from "@/domain/meeting";
import type { Summary } from "@/domain/summary";
import { toPublicMeetingListItem } from "@/lib/publicApi";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: import("react").ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

function makeStatus(overrides: Partial<StatusJson> = {}): StatusJson {
  return {
    id: "m1",
    title: "테스트 회의",
    status: "summarized",
    error: null,
    startedAt: "2026-07-05T13:30:00.000Z",
    endedAt: "2026-07-05T14:00:00.000Z",
    durationMs: 1_800_000,
    audioMime: "audio/webm;codecs=opus",
    whisper: { jobId: null, progress: 1 },
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
  decisions: ["결정 1"],
  actionItems: [{ owner: "딜런", task: "초안 작성", due: "2026-07-08" }],
  risks: [],
  followups: [],
};

// The single persistent signal both surfaces read: status.summarizeAttempt. The list DTO
// exposes it as resummarizeInflight and the detail page passes the same derivation into
// MeetingDetailView's resummarizeInflight prop, so list and detail never disagree (R6).
const derivedInflight = (status: StatusJson) => status.summarizeAttempt !== undefined;

afterEach(() => vi.unstubAllGlobals());

function renderDetail(status: StatusJson) {
  // useHealth polls these endpoints; a benign stub keeps the resting render deterministic.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ configured: false }), {
      headers: { "content-type": "application/json" },
    }),
  ));
  return render(
    <MeetingDetailView
      id={status.id}
      status={status}
      transcript={{ text: "본문", corrected: true }}
      segments={[]}
      summary={SUMMARY}
      hasAudio={false}
      resummarizeInflight={derivedInflight(status)}
    />,
  );
}

describe("목록·상세 상태 일치 (R6)", () => {
  it("재요약 중이면(summarizeAttempt 존재, 옛 summary.json으로 파생은 summarized) 목록과 상세 모두 '요약 중'", () => {
    const status = makeStatus({
      status: "summarized",
      summarizeAttempt: { attemptId: "a1", kind: "resummarize", startedAt: "2026-07-05T14:10:00.000Z" },
    });

    const list = render(
      <MeetingList meetings={[toPublicMeetingListItem(status)]} onRenamed={vi.fn()} onDeleted={vi.fn()} />,
    );
    expect(screen.getByText("요약 중")).toBeInTheDocument();
    expect(screen.queryByText("요약 완료")).not.toBeInTheDocument();
    list.unmount();

    renderDetail(status);
    expect(screen.getByText("요약 생성 중…")).toBeInTheDocument();
    expect(screen.queryByText("요약 완료")).not.toBeInTheDocument();
  });

  it("완료되면(summarizeAttempt 없음) 목록과 상세가 함께 '요약 완료'로 수렴", () => {
    const status = makeStatus({ status: "summarized" });

    const list = render(
      <MeetingList meetings={[toPublicMeetingListItem(status)]} onRenamed={vi.fn()} onDeleted={vi.fn()} />,
    );
    expect(screen.getByText("요약 완료")).toBeInTheDocument();
    expect(screen.queryByText("요약 중")).not.toBeInTheDocument();
    list.unmount();

    renderDetail(status);
    expect(screen.getByText("요약 완료")).toBeInTheDocument();
    expect(screen.queryByText("요약 생성 중…")).not.toBeInTheDocument();
  });
});
