import { describe, expect, it } from "vitest";

import type { StatusJson } from "@/domain/meeting";
import { classifyMeetingRecord, type ClassifiedMeetingRecord } from "@/domain/library";
import { computeSummaryWork } from "@/lib/summaryWork";

function record(
  id: string,
  startedAt: string,
  over: Partial<StatusJson> = {},
): ClassifiedMeetingRecord {
  const status: StatusJson = {
    id,
    title: id,
    status: "transcribed",
    error: null,
    startedAt,
    endedAt: startedAt,
    durationMs: 1,
    audioMime: "audio/webm",
    whisper: { jobId: null, progress: 1 },
    paths: { audio: "/a", play: "/p", raw: "/r", transcript: "/t", summary: "/s", segments: "/g" },
    review: { participants: [] },
    updatedAt: startedAt,
    ...over,
  };
  return classifyMeetingRecord({
    entryKind: "published",
    meetingId: id,
    safety: "safe",
    status: { kind: "valid", value: status },
    hasAudio: true,
  });
}

describe("global summary-work aggregate", () => {
  const records = [
    record("oldest", "2026-07-08T00:00:00.000Z", { error: { message: "x", action: "retry_summary" } }),
    record("next", "2026-07-09T00:00:00.000Z", { error: { message: "x", action: "retry_summary" } }),
    record("processing", "2026-07-10T00:00:00.000Z"),
    record("done", "2026-07-07T00:00:00.000Z", { status: "summarized" }),
  ];

  it("counts globally and walks attention oldest-first without titles", () => {
    const first = computeSummaryWork(records);
    expect(first.summaryWork).toMatchObject({ processing: 1, needsAttention: 2 });
    expect(first.summaryWork.attention?.meetingId).toBe("oldest");
    expect(JSON.stringify(first)).not.toContain("title");

    const second = computeSummaryWork(records, first.summaryWork.attention?.cursor ?? null);
    expect(second.summaryWork.attention?.meetingId).toBe("next");
    const end = computeSummaryWork(records, second.summaryWork.attention?.cursor ?? null);
    expect(end.summaryWork.attention).toBeNull();
    expect(end.summaryWork.needsAttention).toBe(2);
  });

  it("requires an explicit restart after end and rejects malformed cursors", () => {
    expect(computeSummaryWork(records, null).summaryWork.attention?.meetingId).toBe("oldest");
    expect(() => computeSummaryWork(records, "bad")).toThrowError("invalid_attention_cursor");
  });
});
