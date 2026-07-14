// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  collectTranscriptCandidates,
  extractQueryKeywords,
} from "@/lib/transcriptSearch";

describe("extractQueryKeywords (Korean particle relaxation)", () => {
  it("strips trailing particles/endings so a bare stem remains", () => {
    expect(extractQueryKeywords("라이드를 회의록 요약해줘")).toContain("라이드");
    expect(extractQueryKeywords("고퀄에서 대표님 액션")).toEqual(
      expect.arrayContaining(["고퀄", "대표", "액션"]),
    );
    expect(extractQueryKeywords("프로젝트의 결정은")).toEqual(
      expect.arrayContaining(["프로젝트", "결정"]),
    );
  });

  it("does not over-strip a short token down to a single syllable", () => {
    // "회의" ends with the particle "의"; stripping would leave one syllable, so
    // the whole token must survive as a keyword.
    expect(extractQueryKeywords("회의")).toContain("회의");
  });

  it("returns nothing for blank or punctuation-only queries", () => {
    expect(extractQueryKeywords("   ")).toEqual([]);
    expect(extractQueryKeywords("...")).toEqual([]);
  });
});

describe("collectTranscriptCandidates", () => {
  const inputs = [
    { meetingId: "m-ride", transcript: "오늘 라이드 프로젝트 일정과 예산을 논의했습니다." },
    { meetingId: "m-gokual", transcript: "고퀄 대표님이 신규 채용 방향을 결정했습니다." },
    { meetingId: "m-other", transcript: "재무 팀에서 분기 매출을 검토했습니다." },
  ];

  it("returns meetings that contain a transcript-only proper noun with a snippet", () => {
    const ride = collectTranscriptCandidates(inputs, "라이드 요약");
    expect(ride.candidates.map((candidate) => candidate.meetingId)).toContain("m-ride");
    const rideCandidate = ride.candidates.find((candidate) => candidate.meetingId === "m-ride");
    expect(rideCandidate?.snippets[0]?.text).toContain("라이드");

    const gokual = collectTranscriptCandidates(inputs, "고퀄 대표님 액션 아이템");
    expect(gokual.candidates.map((candidate) => candidate.meetingId)).toContain("m-gokual");
  });

  it("returns no candidates for a term absent from every transcript", () => {
    expect(collectTranscriptCandidates(inputs, "존재하지않는고유명사XYZ").candidates).toEqual([]);
  });

  it("excludes meetings whose transcript is unavailable (tombstone/corrupt/missing)", () => {
    const withUnavailable = [
      { meetingId: "m-ride", transcript: null },
      { meetingId: "m-gokual", transcript: "고퀄 대표님 회의" },
    ];
    const result = collectTranscriptCandidates(withUnavailable, "라이드 고퀄");
    expect(result.candidates.map((candidate) => candidate.meetingId)).toEqual(["m-gokual"]);
  });

  it("ranks meetings matching more keywords first and bounds the candidate list", () => {
    const result = collectTranscriptCandidates(
      [
        { meetingId: "weak", transcript: "라이드 관련 잡담이 있었습니다." },
        { meetingId: "strong", transcript: "라이드 프로젝트 예산 회의를 했습니다." },
      ],
      "라이드 프로젝트 예산",
      { limit: 1 },
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].meetingId).toBe("strong");
    expect(result.hasMore).toBe(true);
  });
});
