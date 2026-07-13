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
  it("재요약 inflight면 파생 status가 summarized여도 '요약 중'을 보인다", () => {
    // The re-summarize publisher overwrites summary.json last, so deriveStatus keeps the
    // row at `summarized` throughout the run. The durable inflight flag overlays 요약 중.
    renderRow({ status: "summarized", resummarizeInflight: true });
    expect(screen.getByText("요약 중")).toBeInTheDocument();
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
