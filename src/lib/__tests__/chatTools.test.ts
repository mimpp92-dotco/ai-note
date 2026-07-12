// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { KnowledgeCard } from "@/domain/knowledge";
import {
  ChatToolError,
  createChatToolExecutor,
  type ChatToolDependencies,
} from "@/lib/chatTools";

const MEETING = "meeting-1";

function card(meetingId = MEETING, oneLine = "제품 로드맵을 확정했습니다."): KnowledgeCard {
  return {
    schemaVersion: 1,
    meetingId,
    sourceHashes: { summary: "a".repeat(64), transcript: "b".repeat(64) },
    content: {
      oneLine,
      purpose: "로드맵 검토",
      highlights: ["출시 범위 확정"],
      discussion: ["2분기 범위 논의"],
      decisions: ["베타 출시"],
      risks: [],
      followups: [],
    },
    actionItems: [{ owner: "민수", task: "일정 작성", due: "금요일", searchText: "민수 일정 작성 금요일" }],
    reviewParticipants: ["오래된 참석자"],
    mentionedPeople: ["민수"],
  };
}

function liveRecord(meetingId = MEETING) {
  return {
    meetingId,
    title: "현재 제품 회의",
    status: "summarized" as const,
    startedAt: "2026-07-12T00:00:00.000Z",
    location: {
      workspaceId: "10000000-0000-4000-8000-000000000001",
      folderId: null,
      breadcrumb: ["현재 워크스페이스", "미분류"],
    },
    reviewParticipants: ["현재 참석자"],
    summarizeAttemptPending: false,
  };
}

function dependencies(overrides: Partial<ChatToolDependencies> = {}): ChatToolDependencies {
  return {
    readUserProfile: vi.fn().mockResolvedValue({
      configured: false,
      defaults: { timezone: "Asia/Seoul", weekStartsOn: "monday" },
    }),
    searchMeetings: vi.fn().mockResolvedValue({
      query: "로드맵",
      results: [{
        meetingId: MEETING,
        title: "현재 제품 회의",
        status: "summarized",
        startedAt: "2026-07-12T00:00:00.000Z",
        location: liveRecord().location,
        matches: [{ field: "title", label: "제목", excerpt: "현재 제품 회의" }],
        href: `/meetings/${MEETING}`,
      }],
      hasMore: false,
      summaryPendingCount: 0,
      index: { status: "ready", reasons: [], reindexable: false },
    }),
    readKnowledgeCard: vi.fn().mockResolvedValue({ mode: "ready", card: card() }),
    readArtifactPair: vi.fn().mockResolvedValue({
      transcript: "로드맵을 논의했습니다.",
      summary: JSON.stringify({ title: "모델 제목", oneLine: "로드맵 확정" }),
      state: "stable",
    }),
    inspectTombstone: vi.fn().mockResolvedValue({ state: "none" }),
    acquireArtifactReadLease: vi.fn().mockResolvedValue({ release: vi.fn() }),
    readLiveSnapshot: vi.fn().mockResolvedValue({
      mode: "ready",
      snapshot: {
        generation: { libraryId: "library-1", revision: 1 },
        records: [liveRecord()],
        invalidRecords: [],
      },
    }),
    ...overrides,
  };
}

function call(name: string, args: Record<string, unknown>, callId = "call-1") {
  return { callId, name, arguments: args };
}

describe("chat tool input boundary", () => {
  it("does not accept paths, unknown tools, duplicate IDs, or mode-over-limit artifact reads", async () => {
    const executor = createChatToolExecutor({ mode: "normal", dependencies: dependencies() });
    for (const input of [
      call("read_summaries", { path: "/Users/me/summary.json" }),
      call("read_full_transcript", { meetingId: MEETING, path: "/etc/passwd" }),
      call("read_file", { path: "/etc/passwd" }),
    ]) {
      await expect(executor.execute(input)).rejects.toBeInstanceOf(ChatToolError);
    }
    await expect(executor.execute(call("read_knowledge_cards", {
      meetingIds: [MEETING, MEETING],
    }))).resolves.toMatchObject({ status: "error", error: { code: "duplicate_meeting_id" } });
    const tooMany = Array.from({ length: 51 }, (_, index) => `meeting-${index}`);
    await expect(executor.execute(call("read_knowledge_cards", { meetingIds: tooMany })))
      .resolves.toMatchObject({
        status: "error",
        error: { code: "budget_exhausted" },
        budgetExhausted: true,
      });
  });
});

describe("artifact evidence tools", () => {
  it("uses safe ID → first fence → read lease → second fence → card read and releases the lease", async () => {
    const events: string[] = [];
    let fence = 0;
    const deps = dependencies({
      inspectTombstone: vi.fn(async () => {
        events.push(`fence-${++fence}`);
        return { state: "none" as const };
      }),
      acquireArtifactReadLease: vi.fn(async () => {
        events.push("lease");
        return { release: () => events.push("release") };
      }),
      readKnowledgeCard: vi.fn(async () => {
        events.push("card");
        return { mode: "ready" as const, card: card() };
      }),
      readLiveSnapshot: vi.fn(async () => {
        events.push("live");
        return {
          mode: "ready" as const,
          snapshot: {
            generation: { libraryId: "library-1", revision: 1 },
            records: [liveRecord()],
            invalidRecords: [],
          },
        };
      }),
    });
    const executor = createChatToolExecutor({ mode: "normal", dependencies: deps });
    const result = await executor.execute(call("read_knowledge_cards", { meetingIds: [MEETING] }));

    expect(result.status).toBe("ok");
    expect(events.slice(0, 5)).toEqual(["fence-1", "lease", "fence-2", "card", "release"]);
    expect(events.at(-1)).toBe("live");
  });

  it.each([
    [{ state: "deleted" as const, tombstone: { id: MEETING, deletedAt: "2026-07-12T00:00:00.000Z" } }, "meeting_deleted"],
    [{ state: "ambiguous" as const }, "delete_state_ambiguous"],
  ])("fails closed for %j before reading artifacts", async (observation, reason) => {
    const acquire = vi.fn();
    const executor = createChatToolExecutor({
      mode: "normal",
      dependencies: dependencies({
        inspectTombstone: vi.fn().mockResolvedValue(observation),
        acquireArtifactReadLease: acquire,
      }),
    });
    const result = await executor.execute(call("read_summaries", { meetingIds: [MEETING] }));
    expect(result).toMatchObject({
      status: "ok",
      data: { items: [{ meetingId: MEETING, status: "unavailable", reason }] },
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("does not expose stale card metadata and joins current title/location/review participants", async () => {
    const executor = createChatToolExecutor({ mode: "normal", dependencies: dependencies() });
    const result = await executor.execute(call("read_knowledge_cards", { meetingIds: [MEETING] }));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected success");
    const item = (result.data as { items: Array<{ cardJson: string }> }).items[0];
    const publicCard = JSON.parse(item.cardJson) as Record<string, unknown>;
    expect(publicCard).toMatchObject({
      meetingId: MEETING,
      metadata: {
        currentTitle: "현재 제품 회의",
        location: { breadcrumb: ["현재 워크스페이스", "미분류"] },
        reviewParticipants: ["현재 참석자"],
      },
    });
    expect(item.cardJson).not.toContain("오래된 참석자");
  });

  it.each([
    ["missing", "artifact_missing"],
    ["stale", "card_stale"],
    ["corrupt", "card_corrupt"],
    ["io_error", "artifact_unavailable"],
  ] as const)("lowers %s card reads to a typed unavailable item", async (mode, reason) => {
    const read = mode === "stale" ? { mode, card: card() } : { mode };
    const executor = createChatToolExecutor({
      mode: "normal",
      dependencies: dependencies({ readKnowledgeCard: vi.fn().mockResolvedValue(read) }),
    });
    const result = await executor.execute(call("read_knowledge_cards", { meetingIds: [MEETING] }));
    expect(result).toMatchObject({
      status: "ok",
      data: { items: [{ meetingId: MEETING, status: "unavailable", reason }] },
    });
  });
});

describe("transcript bounds", () => {
  it("returns non-overlapping query windows capped at 4,000 chars with request-opaque cursors", async () => {
    const transcript = [
      `로드맵 ${"가".repeat(4_500)}`,
      `로드맵 ${"나".repeat(4_500)}`,
      `로드맵 ${"다".repeat(4_500)}`,
    ].join("\n");
    const executor = createChatToolExecutor({
      mode: "normal",
      dependencies: dependencies({
        readArtifactPair: vi.fn().mockResolvedValue({ transcript, summary: "{}", state: "stable" }),
      }),
    });
    const first = await executor.execute(call("read_transcript_chunks", {
      meetingId: MEETING,
      query: "로드맵",
      limit: 1,
    }));
    expect(first.status).toBe("ok");
    if (first.status !== "ok") throw new Error("expected success");
    const firstData = first.data as { windows: Array<{ start: number; end: number; text: string }>; nextCursor?: string };
    expect(firstData.windows).toHaveLength(1);
    expect(Array.from(firstData.windows[0].text).length).toBeLessThanOrEqual(4_000);
    expect(firstData.nextCursor).toMatch(/^cursor-/u);

    const second = await executor.execute(call("read_transcript_chunks", {
      meetingId: MEETING,
      query: "로드맵",
      cursor: firstData.nextCursor,
      limit: 2,
    }, "call-2"));
    expect(second.status).toBe("ok");
    if (second.status !== "ok") throw new Error("expected success");
    const secondData = second.data as { windows: Array<{ start: number; end: number; text: string }> };
    expect(secondData.windows.every((window) => window.start >= firstData.windows[0].end)).toBe(true);

    const forged = await executor.execute(call("read_transcript_chunks", {
      meetingId: MEETING,
      query: "로드맵",
      cursor: "cursor-forged",
      limit: 1,
    }, "call-3"));
    expect(forged).toMatchObject({ status: "error", error: { code: "invalid_cursor" } });
  });

  it("requires chunk search for full transcripts over 60,000 chars", async () => {
    const executor = createChatToolExecutor({
      mode: "normal",
      dependencies: dependencies({
        readArtifactPair: vi.fn().mockResolvedValue({
          transcript: "가".repeat(60_001),
          summary: "{}",
          state: "stable",
        }),
      }),
    });
    const result = await executor.execute(call("read_full_transcript", { meetingId: MEETING }));
    expect(result).toMatchObject({
      status: "error",
      error: { code: "transcript_too_large" },
      budgetExhausted: false,
    });
  });

  it("never exceeds the aggregate output budget and records budget exhaustion safely", async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `meeting-${index}`);
    const deps = dependencies({
      readKnowledgeCard: vi.fn(async (id: string) => ({ mode: "ready" as const, card: card(id, "가".repeat(7_900)) })),
      readLiveSnapshot: vi.fn().mockResolvedValue({
        mode: "ready",
        snapshot: {
          generation: { libraryId: "library-1", revision: 1 },
          records: ids.map(liveRecord),
          invalidRecords: [],
        },
      }),
    });
    const executor = createChatToolExecutor({ mode: "normal", dependencies: deps });
    const result = await executor.execute(call("read_knowledge_cards", { meetingIds: ids }));
    expect(result).toMatchObject({
      status: "error",
      error: { code: "aggregate_budget_exhausted" },
      budgetExhausted: true,
    });
    expect(executor.snapshot().budget.aggregateToolOutputCharsUsed).toBeLessThanOrEqual(120_000);
  });
});

describe("request-fixed profile context", () => {
  it("returns missing as normal with injected runtime timezone and a fixed request-start local datetime", async () => {
    const executor = createChatToolExecutor({
      mode: "normal",
      now: () => new Date("2026-01-01T12:34:56.000Z"),
      runtimeTimezone: () => "Asia/Seoul",
      dependencies: dependencies(),
    });
    const first = await executor.execute(call("get_user_profile", {}));
    const second = await executor.execute(call("get_user_profile", {}, "call-2"));
    expect(first).toMatchObject({
      status: "ok",
      data: {
        configured: false,
        runtimeTimezone: "Asia/Seoul",
        weekStartsOn: "monday",
        currentLocalDateTime: "2026-01-01T21:34:56",
      },
    });
    expect(second.status === "ok" && first.status === "ok" && second.data).toEqual(first.status === "ok" ? first.data : null);
  });

  it("formats configured current time in the profile timezone", async () => {
    const executor = createChatToolExecutor({
      mode: "normal",
      now: () => new Date("2026-01-01T12:34:56.000Z"),
      runtimeTimezone: () => "Asia/Seoul",
      dependencies: dependencies({
        readUserProfile: vi.fn().mockResolvedValue({
          configured: true,
          profile: {
            schemaVersion: 1,
            displayName: "Dylan",
            aliases: ["딜런"],
            timezone: "America/New_York",
            weekStartsOn: "monday",
          },
        }),
      }),
    });
    const result = await executor.execute(call("get_user_profile", {}));
    expect(result).toMatchObject({
      status: "ok",
      data: {
        configured: true,
        profile: { timezone: "America/New_York" },
        currentLocalDateTime: "2026-01-01T07:34:56",
      },
    });
  });

  it("distinguishes corrupt/I/O profile from missing and still allows meeting search", async () => {
    const executor = createChatToolExecutor({
      mode: "normal",
      dependencies: dependencies({
        readUserProfile: vi.fn().mockRejectedValue(new Error("/Users/private/profile.json")),
      }),
    });
    await expect(executor.execute(call("get_user_profile", {}))).resolves.toMatchObject({
      status: "error",
      error: { code: "profile_unavailable" },
    });
    await expect(executor.execute(call("search_meetings", { query: "로드맵" }, "call-2")))
      .resolves.toMatchObject({ status: "ok", data: { results: [{ meetingId: MEETING }] } });
  });
});
