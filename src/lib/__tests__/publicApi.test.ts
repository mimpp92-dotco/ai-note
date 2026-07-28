import { describe, expect, it, vi } from "vitest";

import type { StatusJson } from "@/domain/meeting";
import {
  classifyLlmFailure,
  publicErrorResponse,
  safeLog,
  toPublicMeeting,
  toPublicMeetingListItem,
} from "@/lib/publicApi";

function status(): StatusJson & Record<string, unknown> {
  return {
    id: "meeting-1",
    title: "회의",
    titleOverride: "공개 제목",
    status: "transcribed",
    error: { message: "raw /Users/dylan token@example.com", action: "retry_summary" },
    startedAt: "2026-07-10T00:00:00.000Z",
    endedAt: "2026-07-10T01:00:00.000Z",
    durationMs: 3_600_000,
    audioMime: "audio/webm",
    whisper: { jobId: "internal-job-id", progress: 0.5 },
    paths: {
      audio: "/Users/dylan/audio.webm",
      play: "/Users/dylan/play.webm",
      raw: "/Users/dylan/raw.md",
      transcript: "/Users/dylan/transcript.md",
      summary: "/Users/dylan/summary.json",
      segments: "/Users/dylan/segments.json",
    },
    review: { participants: ["딜런"] },
    summarizeAttempts: 3,
    updatedAt: "2026-07-10T01:00:00.000Z",
    futureDispatch: { id: "secret-dispatch" },
  };
}

describe("public meeting DTO allowlist", () => {
  it("keeps lifecycle/review fields and strips paths, jobs, attempts, and unknown internals", () => {
    const dto = toPublicMeeting(status());
    expect(dto).toMatchObject({
      id: "meeting-1",
      title: "회의",
      titleOverride: "공개 제목",
      status: "transcribed",
      whisper: { progress: 0.5 },
      review: { participants: ["딜런"] },
      error: { code: "summary_failed", action: "retry_summary" },
      contentOperation: null,
    });
    const serialized = JSON.stringify(dto);
    for (const sentinel of ["/Users", "internal-job-id", "summarizeAttempts", "secret-dispatch", "token@example.com"]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("uses a smaller explicit list item DTO", () => {
    expect(toPublicMeetingListItem(status())).toEqual({
      id: "meeting-1",
      title: "회의",
      status: "transcribed",
      startedAt: "2026-07-10T00:00:00.000Z",
      error: {
        code: "summary_failed",
        message: "요약을 완료하지 못했습니다. 설정을 확인한 뒤 다시 시도해 주세요",
        action: "retry_summary",
      },
      contentOperation: null,
      resummarizeInflight: false,
    });
  });

  it("marks the list item in-flight from the durable summarizeAttempt signal", () => {
    // A (re)summarize commits status.summarizeAttempt (the same persistent signal
    // the detail view reads) before running. deriveStatus leaves an old summary.json
    // at `summarized`, so this boolean is how list and detail agree on 요약 중 (R6).
    const running: StatusJson = {
      ...status(),
      error: null,
      summarizeAttempt: {
        attemptId: "attempt-1",
        kind: "resummarize",
        startedAt: "2026-07-10T00:30:00.000Z",
      },
    };
    expect(toPublicMeetingListItem(running).resummarizeInflight).toBe(true);
    expect(toPublicMeetingListItem(status()).resummarizeInflight).toBe(false);
  });

  it.each([
    ["initial", "initial", true],
    ["resummarize", "summary", true],
    ["transcript_regenerate", "transcript", false],
    ["summary_regenerate", "summary", true],
    ["manual_edit", null, false],
  ] as const)("maps %s to its public content operation", (kind, operation, legacyInflight) => {
    const intendedContentRevision = {
      transcript: {
        source: "generated" as const,
        sha256: "a".repeat(64),
        updatedAt: "2026-07-10T00:30:00.000Z",
      },
      summary: {
        source: "generated" as const,
        sha256: "b".repeat(64),
        basedOnTranscriptSha256: "a".repeat(64),
        updatedAt: "2026-07-10T00:30:00.000Z",
      },
    };
    const running = {
      ...status(),
      summarizeAttempt: {
        attemptId: "00000000-0000-4000-8000-000000000011",
        kind,
        startedAt: "2026-07-10T00:30:00.000Z",
        ...(["initial", "resummarize"].includes(kind) ? {} : { intendedContentRevision }),
      },
    } as StatusJson;
    expect(toPublicMeeting(running).contentOperation).toBe(operation);
    expect(toPublicMeetingListItem(running)).toMatchObject({
      contentOperation: operation,
      resummarizeInflight: legacyInflight,
    });
  });

  it("preserves the transcript-generation retry action without treating it as retry_summary", () => {
    const dto = toPublicMeeting({
      ...status(),
      error: {
        code: "private_provider_detail",
        message: "raw /Users/private",
        action: "retry_transcript_generation",
      },
    });
    expect(dto.error).toEqual({
      code: "transcript_generation_failed",
      message: "전체 스크립트를 다시 만들지 못했습니다. 설정을 확인한 뒤 다시 시도해 주세요",
      action: "retry_transcript_generation",
    });
  });
});

describe("safe errors and logging", () => {
  it.each([
    [new Error("spawn claude ENOENT"), "summary_tool_missing"],
    [new Error("process timed out after 600000ms"), "summary_timeout"],
    [new Error("Not logged in · Please run /login"), "summary_auth_required"],
    [new Error("transcript sentinel@example.com https://secret.test /Users/me"), "summary_provider_failed"],
  ] as const)("classifies an LLM failure without retaining raw output", (error, code) => {
    const classified = classifyLlmFailure(error, "claude-cli");
    expect(classified.code).toBe(code);
    expect(JSON.stringify(classified)).not.toMatch(/sentinel|secret\.test|\/Users|Not logged in|ENOENT/i);
    expect(classified.action).toBe("retry_summary");
  });

  it("builds a stable no-store error envelope with allowlisted safe details", async () => {
    const response = publicErrorResponse("library_revision_conflict", 409, {
      workspaceId: "safe-id",
      unsafeName: "should disappear",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "library_revision_conflict",
        message: "최신 상태를 확인한 뒤 다시 시도해 주세요",
        details: { workspaceId: "safe-id" },
      },
    });
  });

  it.each([
    "content_revision_conflict",
    "content_operation_in_progress",
    "content_source_conflict",
    "content_state_ambiguous",
    "content_save_unavailable",
  ] as const)("keeps content error %s static and safe", async (code) => {
    const response = publicErrorResponse(code, code === "content_save_unavailable" ? 503 : 409, {
      field: "transcript",
      operation: "manual_edit",
      path: "/Users/private",
    });
    const body = await response.json();
    expect(body).toMatchObject({ error: { code, details: {
      field: "transcript",
      operation: "manual_edit",
    } } });
    expect(JSON.stringify(body)).not.toContain("/Users/private");
  });

  it("keeps pipeline settings corruption unavailable without leaking stored bytes", async () => {
    const response = publicErrorResponse("pipeline_settings_unavailable", 503, {
      path: "/Users/private/data/pipeline-settings.json",
      providerOutput: "{malformed private value",
    });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: "pipeline_settings_unavailable",
        message: "전사·교정 설정을 안전하게 불러올 수 없습니다",
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/Users|malformed|providerOutput/u);
  });

  it.each([
    ["chat_llm_unconfigured", 409],
    ["chat_llm_unavailable", 503],
    ["chat_timeout", 504],
    ["chat_index_unavailable", 503],
  ] as const)("keeps chat error %s static and strips raw provider/path details", async (code, status) => {
    const response = publicErrorResponse(code, status, {
      path: "/Users/private/transcript.md",
      providerOutput: "token@example.com model stderr",
      meetingId: "meeting-1",
    });
    const payload = await response.json();
    expect(payload).toMatchObject({ error: { code, details: { meetingId: "meeting-1" } } });
    expect(JSON.stringify(payload)).not.toMatch(/\/Users|token@example|providerOutput|stderr/u);
  });

  it("logs only the structured allowlist and never serializes Error/raw values", () => {
    const sink = vi.fn();
    safeLog("warn", {
      code: "summary_provider_failed",
      operation: "summarize",
      meetingId: "meeting-1",
      error: new Error("token@example.com /Users/me"),
      raw: "private transcript",
    }, sink);
    expect(sink).toHaveBeenCalledWith({
      level: "warn",
      code: "summary_provider_failed",
      operation: "summarize",
      meetingId: "meeting-1",
    });
  });
});
