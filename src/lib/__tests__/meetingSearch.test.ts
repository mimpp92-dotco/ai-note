// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { CorpusMap, KnowledgeCard } from "@/domain/knowledge";
import type { MeetingStatus } from "@/domain/meeting";
import {
  EXACT_PHRASE_BONUS,
  MeetingSearchInputError,
  MeetingSearchRetryError,
  SEARCH_FIELD_WEIGHTS,
  normalizeSearchText,
  searchMeetings,
  type MeetingSearchSources,
  type SearchKnowledgeCardReadResult,
  type SearchLiveRecord,
  type SearchLiveSnapshot,
} from "@/lib/meetingSearch";

const GENERATION = {
  libraryId: "90000000-0000-4000-8000-000000000009",
  revision: 7,
};

function card(
  meetingId: string,
  overrides: Partial<KnowledgeCard> = {},
): KnowledgeCard {
  return {
    schemaVersion: 1,
    meetingId,
    sourceHashes: { summary: "a".repeat(64), transcript: "b".repeat(64) },
    content: {
      oneLine: "검색 가능한 한 줄 요약",
      purpose: "제품 로드맵",
      highlights: ["핵심 내용"],
      discussion: ["일반 논의"],
      decisions: ["일반 결정"],
      risks: ["일반 리스크"],
      followups: ["일반 후속"],
    },
    actionItems: [{ owner: "민수", task: "명세 작성", due: "금요일", searchText: "민수 명세 작성 금요일" }],
    reviewParticipants: ["예전 참석자"],
    mentionedPeople: ["민수"],
    ...overrides,
  };
}

function live(
  meetingId: string,
  overrides: Partial<SearchLiveRecord> = {},
): SearchLiveRecord {
  return {
    meetingId,
    title: `현재 제목 ${meetingId}`,
    status: "summarized",
    startedAt: "2026-07-12T09:00:00.000Z",
    location: {
      workspaceId: "10000000-0000-4000-8000-000000000001",
      folderId: "30000000-0000-4000-8000-000000000003",
      breadcrumb: ["현재 워크스페이스", "현재 폴더"],
    },
    reviewParticipants: ["현재 참석자"],
    summarizeAttemptPending: false,
    ...overrides,
  };
}

function corpus(ids: string[]): CorpusMap {
  return {
    schemaVersion: 1,
    cards: ids.map((meetingId) => ({
      meetingId,
      oneLine: "검색 가능한 한 줄 요약",
      purpose: "제품 로드맵",
      highlights: ["핵심 내용"],
      mentionedPeople: ["민수"],
    })),
  };
}

function snapshot(
  records: SearchLiveRecord[],
  overrides: Partial<SearchLiveSnapshot> = {},
): SearchLiveSnapshot {
  return {
    generation: GENERATION,
    records,
    invalidRecords: [],
    ...overrides,
  };
}

function makeSources(options: {
  corpusRead?: Awaited<ReturnType<MeetingSearchSources["readCorpusMap"]>>;
  cards?: Record<string, SearchKnowledgeCardReadResult>;
  snapshots?: SearchLiveSnapshot[];
  tombstones?: Record<string, Awaited<ReturnType<MeetingSearchSources["inspectTombstone"]>>>;
} = {}): MeetingSearchSources {
  const ids = Object.keys(options.cards ?? { "meeting-1": { mode: "ready", card: card("meeting-1") } });
  const snapshots = options.snapshots ?? [snapshot(ids.map((id) => live(id)))];
  let snapshotIndex = 0;
  return {
    readCorpusMap: vi.fn(async (): Promise<Awaited<ReturnType<MeetingSearchSources["readCorpusMap"]>>> => options.corpusRead ?? {
      mode: "ready",
      corpusMap: corpus(ids),
    }),
    readKnowledgeCard: vi.fn(async (meetingId: string): Promise<SearchKnowledgeCardReadResult> => (
      options.cards?.[meetingId] ?? { mode: "missing" as const }
    )),
    readLiveSnapshot: vi.fn(async (): Promise<Awaited<ReturnType<MeetingSearchSources["readLiveSnapshot"]>>> => ({
      mode: "ready" as const,
      snapshot: snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
    })),
    inspectTombstone: vi.fn(async (meetingId: string): Promise<Awaited<ReturnType<MeetingSearchSources["inspectTombstone"]>>> => (
      options.tombstones?.[meetingId] ?? { state: "none" as const }
    )),
  };
}

describe("search text normalization", () => {
  it("uses NFKC, locale-independent lower-case, separator collapse, and preserves technical token punctuation", () => {
    expect(normalizeSearchText("  Ｃ＋＋／C#， V2.1___AI-NOTE\t기획!!!검토  "))
      .toBe("c++ c# v2.1___ai-note 기획 검토");
    expect(normalizeSearchText("alpha—beta / gamma | delta")).toBe("alpha beta gamma delta");
  });

  it("rejects an empty normalized query and more than 500 characters", async () => {
    const sources = makeSources();
    await expect(searchMeetings({ query: "  ／ !!!  " }, sources))
      .rejects.toMatchObject({ code: "invalid_query" } satisfies Partial<MeetingSearchInputError>);
    await expect(searchMeetings({ query: "가".repeat(501) }, sources))
      .rejects.toMatchObject({ code: "query_too_long" } satisfies Partial<MeetingSearchInputError>);
  });
});

describe("deterministic meeting search", () => {
  it.each([
    ["현재 제목", "제목"],
    ["로드맵", "주제"],
    ["명세", "할 일"],
    ["승인", "결정"],
    ["지수", "사람"],
    ["현재 참석자", "참석자"],
  ])("matches %s from the expected live/card field", async (query, label) => {
    const currentCard = card("meeting-1", {
      content: {
        ...card("meeting-1").content,
        decisions: ["출시를 승인했다"],
      },
      mentionedPeople: ["지수"],
    });
    const result = await searchMeetings({ query }, makeSources({
      cards: { "meeting-1": { mode: "ready", card: currentCard } },
      snapshots: [snapshot([live("meeting-1")])],
    }));

    expect(result.results).toHaveLength(1);
    expect(result.results[0].matches.map((match) => match.label)).toContain(label);
  });

  it("requires every token across fields while preserving C++, C#, v2.1, and ai-note tokens", async () => {
    const technical = card("technical", {
      content: {
        ...card("technical").content,
        decisions: ["C++와 C# 도구를 채택"],
        discussion: ["v2.1 배포"],
        followups: ["ai-note 문서화"],
      },
    });
    const sources = makeSources({
      cards: { technical: { mode: "ready", card: technical } },
      snapshots: [snapshot([live("technical", { title: "SDK 검토" })])],
    });

    await expect(searchMeetings({
      query: "SDK C++ C# v2.1 ai-note",
    }, sources)).resolves.toMatchObject({
      results: [{ meetingId: "technical" }],
    });
    await expect(searchMeetings({ query: "SDK Rust" }, makeSources({
      cards: { technical: { mode: "ready", card: technical } },
      snapshots: [snapshot([live("technical", { title: "SDK 검토" })])],
    }))).resolves.toMatchObject({ results: [] });
  });

  it("keeps the weight table explicit, rewards an exact phrase, then uses date and ID stable tie-breaks", async () => {
    expect(SEARCH_FIELD_WEIGHTS).toEqual({
      title: 120,
      topic: 100,
      oneLine: 90,
      highlights: 80,
      decisions: 75,
      actionItems: 70,
      discussion: 60,
      participants: 55,
      people: 50,
      risks: 40,
      followups: 35,
      location: 30,
      date: 20,
      status: 10,
    });
    expect(EXACT_PHRASE_BONUS).toBe(160);

    const ids = ["phrase", "split", "tie-a", "tie-b", "tie-new"];
    const cards = Object.fromEntries(ids.map((id) => [id, {
      mode: "ready" as const,
      card: card(id, {
        content: {
          ...card(id).content,
          purpose: id === "split" ? "beta" : "none",
          discussion: id === "phrase" ? ["alpha beta"] : ["none"],
        },
      }),
    }]));
    const records = [
      live("phrase", { title: "phrase" }),
      live("split", { title: "alpha" }),
      live("tie-b", { title: "stable", startedAt: "2026-07-10T00:00:00.000Z" }),
      live("tie-a", { title: "stable", startedAt: "2026-07-10T00:00:00.000Z" }),
      live("tie-new", { title: "stable", startedAt: "2026-07-11T00:00:00.000Z" }),
    ];

    const phraseResult = await searchMeetings({ query: "alpha beta" }, makeSources({
      cards,
      snapshots: [snapshot(records)],
    }));
    expect(phraseResult.results.map((item) => item.meetingId).slice(0, 2))
      .toEqual(["phrase", "split"]);

    const tieResult = await searchMeetings({ query: "stable" }, makeSources({
      cards,
      snapshots: [snapshot(records)],
    }));
    expect(tieResult.results.map((item) => item.meetingId))
      .toEqual(["tie-new", "tie-a", "tie-b"]);
  });

  it("returns at most three weighted plain-text reasons with 180-character excerpts", async () => {
    const long = `<strong>${"앞".repeat(120)} needle ${"뒤".repeat(120)}</strong> **needle** [링크](https://example.test)`;
    const rich = card("rich", {
      content: {
        oneLine: long,
        purpose: "needle 주제",
        highlights: ["needle 핵심"],
        discussion: ["needle 논의"],
        decisions: ["needle 결정"],
        risks: ["needle 위험"],
        followups: ["needle 후속"],
      },
    });
    const result = await searchMeetings({ query: "needle" }, makeSources({
      cards: { rich: { mode: "ready", card: rich } },
      snapshots: [snapshot([live("rich", { title: "needle 제목" })])],
    }));

    expect(result.results[0].matches).toHaveLength(3);
    for (const match of result.results[0].matches) {
      expect(Array.from(match.excerpt).length).toBeLessThanOrEqual(180);
      expect(match.excerpt).not.toMatch(/<[^>]+>|\*\*|\[[^\]]+\]\([^)]+\)/u);
    }
  });

  it("applies date, workspace, folder, status, and action-item filters before scoring", async () => {
    const statuses: MeetingStatus[] = ["summarized", "transcribed"];
    const records = [
      live("match", { title: "needle", startedAt: "2026-07-12T00:00:00.000Z" }),
      live("wrong-date", { title: "needle", startedAt: "2026-06-01T00:00:00.000Z" }),
      live("wrong-workspace", {
        title: "needle",
        location: { workspaceId: "20000000-0000-4000-8000-000000000002", folderId: null, breadcrumb: ["다른 곳", "미분류"] },
      }),
      live("wrong-folder", {
        title: "needle",
        location: { workspaceId: "10000000-0000-4000-8000-000000000001", folderId: null, breadcrumb: ["현재 워크스페이스", "미분류"] },
      }),
      live("wrong-status", { title: "needle", status: statuses[1] }),
      live("no-action", { title: "needle" }),
    ];
    const cards: Record<string, SearchKnowledgeCardReadResult> = Object.fromEntries(records.map((record) => [
      record.meetingId,
      { mode: "ready", card: card(record.meetingId, record.meetingId === "no-action" ? { actionItems: [] } : {}) },
    ]));
    const result = await searchMeetings({
      query: "needle",
      filters: {
        dateFrom: "2026-07-01",
        dateTo: "2026-07-31",
        workspaceId: "10000000-0000-4000-8000-000000000001",
        folderId: "30000000-0000-4000-8000-000000000003",
        status: statuses[0],
        hasActionItem: true,
      },
    }, makeSources({ cards, snapshots: [snapshot(records)] }));

    expect(result.results.map((item) => item.meetingId)).toEqual(["match"]);
  });

  it("keeps live metadata matches but excludes stale/missing/corrupt semantic text and marks the aggregate partial", async () => {
    const records = [
      live("stale", { title: "현재 메타데이터 검색" }),
      live("missing", { title: "현재 메타데이터 검색" }),
      live("corrupt", { title: "현재 메타데이터 검색" }),
    ];
    const cards: Record<string, SearchKnowledgeCardReadResult> = {
      stale: { mode: "stale" },
      missing: { mode: "missing" },
      corrupt: { mode: "corrupt" },
    };
    const current = await searchMeetings({ query: "현재 메타데이터" }, makeSources({
      cards,
      snapshots: [snapshot(records)],
    }));
    expect(current.results.map((item) => item.meetingId)).toEqual(["corrupt", "missing", "stale"]);
    expect(current.index).toEqual({
      status: "partial",
      reasons: ["missing", "stale", "corrupt"],
      reindexable: true,
    });

    const semantic = await searchMeetings({ query: "검색 가능한" }, makeSources({
      cards,
      snapshots: [snapshot(records)],
    }));
    expect(semantic.results).toEqual([]);
  });

  it("uses current title, location, status, and review participants instead of persisted snapshots", async () => {
    const old = card("current", { reviewParticipants: ["예전 사람"] });
    const current = live("current", {
      title: "새 제목",
      status: "transcribed",
      location: {
        workspaceId: "10000000-0000-4000-8000-000000000001",
        folderId: null,
        breadcrumb: ["새 워크스페이스", "미분류"],
      },
      reviewParticipants: ["새 참석자"],
    });
    for (const query of ["새 제목", "새 워크스페이스", "새 참석자", "요약 대기"]) {
      const result = await searchMeetings({ query }, makeSources({
        cards: { current: { mode: "ready", card: old } },
        snapshots: [snapshot([current])],
      }));
      expect(result.results.map((item) => item.meetingId), query).toEqual(["current"]);
    }
    const oldParticipant = await searchMeetings({ query: "예전 사람" }, makeSources({
      cards: { current: { mode: "ready", card: old } },
      snapshots: [snapshot([current])],
    }));
    expect(oldParticipant.results).toEqual([]);
  });

  it("excludes tombstoned, ambiguous, unsafe, and corrupt live records left in the corpus map", async () => {
    const ids = ["live", "deleted", "ambiguous", "unsafe", "corrupt"];
    const cards = Object.fromEntries(ids.map((id) => [id, { mode: "ready" as const, card: card(id) }]));
    const result = await searchMeetings({ query: "공통" }, makeSources({
      corpusRead: { mode: "stale", corpusMap: corpus(ids) },
      cards,
      snapshots: [snapshot([
        live("live", { title: "공통 live" }),
      ], {
        invalidRecords: [
          { meetingId: "unsafe", reason: "io_error" },
          { meetingId: "corrupt", reason: "corrupt" },
        ],
      })],
      tombstones: {
        deleted: {
          state: "deleted",
          tombstone: { id: "deleted", deletedAt: "2026-07-12T00:00:00.000Z" },
        },
        ambiguous: { state: "ambiguous" },
      },
    }));

    expect(result.results.map((item) => item.meetingId)).toEqual(["live"]);
    expect(result.index.status).toBe("partial");
    expect(result.index.reasons).toEqual(expect.arrayContaining(["stale", "corrupt", "io_error"]));
  });

  it("returns unavailable safely when the corpus map cannot be read", async () => {
    const result = await searchMeetings({ query: "현재" }, makeSources({
      corpusRead: { mode: "missing" },
      snapshots: [snapshot([live("meeting-1")])],
    }));
    expect(result).toMatchObject({
      results: [],
      hasMore: false,
      index: { status: "unavailable", reasons: ["missing"], reindexable: true },
    });
  });

  it("throws a typed retry error instead of mixing two library generations", async () => {
    const first = snapshot([live("meeting-1", { title: "이전 제목" })]);
    const second = snapshot([live("meeting-1", { title: "새 제목" })], {
      generation: { ...GENERATION, libraryId: "80000000-0000-4000-8000-000000000008", revision: 0 },
    });
    await expect(searchMeetings({ query: "제목" }, makeSources({
      cards: { "meeting-1": { mode: "ready", card: card("meeting-1") } },
      snapshots: [first, second],
    }))).rejects.toBeInstanceOf(MeetingSearchRetryError);
  });
});
