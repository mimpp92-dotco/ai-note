// @vitest-environment node
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { StatusJson } from "@/domain/meeting";
import {
  buildCorpusMap,
  buildKnowledgeCard,
  hashKnowledgeSourcePair,
  isKnowledgeCardStale,
  projectKnowledgeCardWithLiveMetadata,
} from "@/lib/knowledgeIndex";

const encoder = new TextEncoder();

const summary = {
  title: "주간 제품 회의",
  topicSlug: "weekly-product",
  oneLine: "검색 기능의 다음 범위를 합의했다",
  purpose: "검색 기능 범위 결정",
  participants: ["전사에서 추측된 사람"],
  highlights: ["키워드 검색을 먼저 제공한다"],
  discussion: ["민수와 지수라는 이름이 대화에 등장했다"],
  decisions: ["벡터 검색은 연기한다"],
  actionItems: [
    { owner: " 민수 ", task: "검색 명세 작성", due: "금요일" },
    { owner: "TODO", task: "담당자 정하기", due: "미정" },
    { owner: "미지정", task: "후속 검토", due: "미정" },
  ],
  risks: ["후보가 너무 많을 수 있다"],
  followups: ["다음 주 검토"],
};

function status(overrides: Partial<StatusJson> = {}): StatusJson {
  return {
    id: "meeting-1",
    title: "현재 제목",
    status: "summarized",
    error: null,
    startedAt: "2026-07-12T00:00:00.000Z",
    endedAt: "2026-07-12T00:30:00.000Z",
    durationMs: 1_800_000,
    audioMime: "audio/webm",
    whisper: { jobId: null, progress: 1 },
    paths: {
      audio: "/stale/absolute/audio.webm",
      play: "/stale/absolute/play.webm",
      raw: "/stale/absolute/raw.md",
      transcript: "/stale/absolute/transcript.md",
      summary: "/stale/absolute/summary.json",
      segments: "/stale/absolute/segments.json",
    },
    review: { participants: ["딜런", "수진"] },
    updatedAt: "2026-07-12T00:31:00.000Z",
    ...overrides,
  };
}

function sourceBytes(overrides: { transcript?: string; summary?: typeof summary } = {}) {
  const transcript = encoder.encode(overrides.transcript ?? "회의 전사 원문\n");
  const summaryBytes = encoder.encode(JSON.stringify(overrides.summary ?? summary));
  return { transcript, summary: summaryBytes };
}

describe("knowledge-card projection", () => {
  it("builds semantic and review fields from one in-memory source-pair snapshot", () => {
    const source = sourceBytes();
    const card = buildKnowledgeCard({ meetingId: "meeting-1", source, status: status() });

    expect(card).toMatchObject({
      schemaVersion: 1,
      meetingId: "meeting-1",
      content: {
        oneLine: summary.oneLine,
        purpose: summary.purpose,
        highlights: summary.highlights,
        discussion: summary.discussion,
        decisions: summary.decisions,
        risks: summary.risks,
        followups: summary.followups,
      },
      actionItems: [
        {
          owner: "민수",
          task: "검색 명세 작성",
          due: "금요일",
          searchText: "민수 검색 명세 작성 금요일",
        },
        {
          owner: "TODO",
          task: "담당자 정하기",
          due: "미정",
          searchText: "TODO 담당자 정하기 미정",
        },
        {
          owner: "미지정",
          task: "후속 검토",
          due: "미정",
          searchText: "미지정 후속 검토 미정",
        },
      ],
      reviewParticipants: ["딜런", "수진"],
      mentionedPeople: ["민수"],
    });
    expect(card.sourceHashes).toEqual({
      transcript: createHash("sha256").update(source.transcript).digest("hex"),
      summary: createHash("sha256").update(source.summary).digest("hex"),
    });
    expect(JSON.stringify(card)).not.toContain("/stale/absolute");
  });

  it("derives people only from deterministic action owners without a second AI extraction", () => {
    const card = buildKnowledgeCard({
      meetingId: "meeting-1",
      source: sourceBytes(),
      status: status(),
    });

    expect(card.mentionedPeople).toEqual(["민수"]);
    expect(card.mentionedPeople).not.toContain("전사에서 추측된 사람");
    expect(card.mentionedPeople).not.toContain("지수");
  });

  it("marks a card stale when either source hash changes", () => {
    const source = sourceBytes();
    const card = buildKnowledgeCard({ meetingId: "meeting-1", source, status: status() });

    expect(isKnowledgeCardStale(card, hashKnowledgeSourcePair(source))).toBe(false);
    expect(isKnowledgeCardStale(card, hashKnowledgeSourcePair({
      ...source,
      transcript: encoder.encode("수정된 전사\n"),
    }))).toBe(true);
    expect(isKnowledgeCardStale(card, hashKnowledgeSourcePair({
      ...source,
      summary: encoder.encode(JSON.stringify({ ...summary, oneLine: "새 요약" })),
    }))).toBe(true);
  });
});

describe("corpus and live metadata projections", () => {
  it("keeps corpus-map bounded and never includes transcript or authoritative mutable metadata", () => {
    const hugeTranscript = `민감한 전체 전사-${"가".repeat(100_000)}`;
    const longSummary = {
      ...summary,
      oneLine: "한".repeat(2_000),
      purpose: "목".repeat(4_000),
      highlights: Array.from({ length: 30 }, (_, index) => `핵심-${index}-${"나".repeat(1_000)}`),
    };
    const card = buildKnowledgeCard({
      meetingId: "meeting-1",
      source: sourceBytes({ transcript: hugeTranscript, summary: longSummary }),
      status: status(),
    });
    const corpus = buildCorpusMap([card]);
    const serialized = JSON.stringify(corpus);

    expect(serialized).not.toContain("민감한 전체 전사");
    expect(serialized).not.toContain("/stale/absolute");
    expect(serialized).not.toContain("현재 제목");
    expect(serialized).not.toContain("딜런");
    expect(serialized.length).toBeLessThan(10_000);
    expect(corpus.cards[0].highlights.length).toBeLessThanOrEqual(8);
  });

  it("lets live title/status/location/review replace every stale index snapshot", () => {
    const card = Object.assign(
      buildKnowledgeCard({ meetingId: "meeting-1", source: sourceBytes(), status: status() }),
      {
        title: "오래된 제목",
        status: "recorded",
        location: { workspaceId: "old", folderId: "old" },
      },
    );
    const projection = projectKnowledgeCardWithLiveMetadata(card, {
      title: "실시간 제목",
      status: "summarized",
      location: { workspaceId: "live", folderId: null, breadcrumb: ["현재"] },
      reviewParticipants: ["현재 검토자"],
    });

    expect(projection).toMatchObject({
      meetingId: "meeting-1",
      title: "실시간 제목",
      status: "summarized",
      location: { workspaceId: "live", folderId: null, breadcrumb: ["현재"] },
      reviewParticipants: ["현재 검토자"],
      mentionedPeople: ["민수"],
    });
    expect(JSON.stringify(projection)).not.toContain("오래된 제목");
    expect(JSON.stringify(projection)).not.toContain("딜런");
  });
});
