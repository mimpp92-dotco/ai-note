import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MeetingRow } from "@/components/MeetingRow";
import type { MeetingListItem } from "@/components/MeetingList";

// GuardedLink (via RecorderNavigation) reads useRouter; usePathname is stubbed for any
// transitive navigation consumers. No LibraryProvider/RecorderSessionProvider is mounted
// so the optional hooks return null — the row renders standalone.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/",
}));

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

function renderRow(over: Partial<MeetingListItem> = {}) {
  return render(
    <ul>
      <MeetingRow meeting={meeting(over)} onRenamed={vi.fn()} onDeleted={vi.fn()} />
    </ul>,
  );
}

describe("MeetingRow — 상태 뱃지", () => {
  it("transcript operation은 전체 스크립트 생성 중으로 구분한다", () => {
    renderRow({ status: "summarized", contentOperation: "transcript" });
    expect(screen.getByText("전체 스크립트 생성 중")).toBeInTheDocument();
    expect(screen.queryByText("회의록 요약 생성 중")).not.toBeInTheDocument();
  });

  it.each(["initial", "summary"] as const)("%s operation은 회의록 요약 생성 중으로 표시한다", (contentOperation) => {
    renderRow({ status: "summarized", contentOperation });
    expect(screen.getByText("회의록 요약 생성 중")).toBeInTheDocument();
    expect(screen.queryByText("전체 스크립트 생성 중")).not.toBeInTheDocument();
  });

  it("manual edit에는 public generation operation이 없으므로 생성 중으로 가장하지 않는다", () => {
    renderRow({ status: "summarized", contentOperation: null, resummarizeInflight: false });
    expect(screen.getByText("요약 완료")).toBeInTheDocument();
    expect(screen.queryByText(/생성 중/)).not.toBeInTheDocument();
  });

  it("operation별 retry는 상세의 해당 content tab으로 연결한다", () => {
    const first = renderRow({
      error: { message: "스크립트 실패", action: "retry_transcript_generation" },
    });
    expect(screen.getByRole("link")).toHaveAttribute("href", "/meetings/m1?contentTab=script");
    first.unmount();

    renderRow({ error: { message: "요약 실패", action: "retry_summary" } });
    expect(screen.getByRole("link")).toHaveAttribute("href", "/meetings/m1?contentTab=summary");
  });

  it("재요약 inflight면 파생 status가 summarized여도 '요약 중'을 보인다", () => {
    // The re-summarize publisher overwrites summary.json last, so deriveStatus keeps the
    // row at `summarized` throughout the run. The durable inflight flag overlays 요약 중.
    renderRow({ status: "summarized", resummarizeInflight: true });
    expect(screen.getByText("회의록 요약 생성 중")).toBeInTheDocument();
    expect(screen.queryByText("요약 완료")).not.toBeInTheDocument();
  });

  it("inflight이 아니면 파생 status 라벨(요약 완료)로 돌아온다", () => {
    renderRow({ status: "summarized", resummarizeInflight: false });
    expect(screen.getByText("요약 완료")).toBeInTheDocument();
    expect(screen.queryByText("요약 중")).not.toBeInTheDocument();
  });

  it("inflight 신호가 없어도 transcribed 등 파생 status 라벨은 그대로 렌더한다", () => {
    renderRow({ status: "transcribed" });
    expect(screen.getByText("교정 대기")).toBeInTheDocument();
    expect(screen.queryByText("요약 중")).not.toBeInTheDocument();
  });
});
