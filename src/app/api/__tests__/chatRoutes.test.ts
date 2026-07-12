// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const orchestratorState = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@/lib/chatOrchestrator", () => {
  class ChatOrchestratorError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return { ChatOrchestratorError, runChat: orchestratorState.run };
});

import {
  dynamic,
  POST,
  runtime,
} from "@/app/api/chat/route";

const ORIGIN = "http://127.0.0.1:3000";

const safeResult = {
  answerSegments: [{
    kind: "claim",
    format: "paragraph",
    text: "로드맵 범위를 확정했습니다.",
    referenceNumbers: [1],
  }],
  references: [{
    number: 1,
    meetingId: "meeting-1",
    currentTitle: "현재 제품 회의",
    startedAt: "2026-07-12T00:00:00.000Z",
    href: "/meetings/meeting-1",
  }],
  evidenceStatus: "sufficient",
  checkedScope: {
    searchResults: 1,
    knowledgeCards: 0,
    summaries: 1,
    transcriptWindows: 0,
    fullTranscripts: 0,
    distinctMeetings: 1,
  },
  warnings: [],
  searchReplay: { query: "로드맵", filters: {}, limit: 20, resultCount: 1 },
};

function request(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/chat`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: ORIGIN,
      "content-type": "application/json",
      ...headers,
    },
    body,
    duplex: "half",
  } as RequestInit);
}

beforeEach(() => {
  orchestratorState.run.mockReset();
  orchestratorState.run.mockResolvedValue(safeResult);
});

describe("POST /api/chat", () => {
  it("is Node dynamic and applies the local guard before reading the body or starting the model", async () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        controller.close();
      },
    });
    const denied = new Request("http://evil.test/api/chat", {
      method: "POST",
      headers: { host: "evil.test", "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const reader = vi.spyOn(denied.body as ReadableStream<Uint8Array>, "getReader");

    const response = await POST(denied);
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(reader).not.toHaveBeenCalled();
    expect(orchestratorState.run).not.toHaveBeenCalled();
  });

  it("validates the strict request and returns a no-store safe public DTO", async () => {
    const input = {
      message: "로드맵 결정은?",
      mode: "normal",
      history: [{ role: "user", content: "지난 질문" }, {
        role: "assistant",
        content: "지난 답",
        referenceMap: [{ number: 1, meetingId: "meeting-1" }],
      }],
    };
    const response = await POST(request(JSON.stringify(input)));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(orchestratorState.run).toHaveBeenCalledWith(input);
    expect(body).toEqual(safeResult);
    expect(JSON.stringify(body)).not.toMatch(/citationMeetingIds|claimedIds|modelTitle|provider|prompt|toolTrace|confidence/u);
  });

  it.each([
    ["text/plain", JSON.stringify({ message: "질문", mode: "normal" }), 415],
    ["application/json", "{", 400],
    ["application/json", JSON.stringify({ message: "질문", mode: "normal", extra: true }), 400],
    ["application/json", JSON.stringify({ message: "a".repeat(4_001), mode: "normal" }), 400],
    ["application/json", JSON.stringify({ message: "질문", mode: "fast" }), 400],
    ["application/json", JSON.stringify({
      message: "질문",
      mode: "normal",
      history: [{ role: "assistant", content: "역순" }, { role: "user", content: "질문" }],
    }), 400],
  ])("rejects invalid content/body contract", async (contentType, body, status) => {
    const response = await POST(request(body, { "content-type": contentType }));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(orchestratorState.run).not.toHaveBeenCalled();
  });

  it("rejects a declared body over 128 KiB before stream consumption", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    const oversized = request(stream, { "content-length": String(128 * 1024 + 1) });
    const reader = vi.spyOn(oversized.body as ReadableStream<Uint8Array>, "getReader");
    const response = await POST(oversized);
    expect(response.status).toBe(413);
    expect(reader).not.toHaveBeenCalled();
    expect(orchestratorState.run).not.toHaveBeenCalled();
  });

  it.each([
    ["chat_llm_unconfigured", 409],
    ["chat_llm_unavailable", 503],
    ["chat_timeout", 504],
    ["chat_index_unavailable", 503],
  ] as const)("maps %s to a typed actionable no-store response", async (code, status) => {
    const { ChatOrchestratorError } = await import("@/lib/chatOrchestrator");
    orchestratorState.run.mockRejectedValueOnce(new ChatOrchestratorError(code));
    const response = await POST(request(JSON.stringify({ message: "질문", mode: "normal" })));
    const body = await response.json();
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ error: { code } });
    expect(JSON.stringify(body)).not.toMatch(/\/Users|provider output|prompt|stack/u);
  });

  it("does not warn globally for a missing profile on a general question", async () => {
    orchestratorState.run.mockResolvedValueOnce({ ...safeResult, warnings: [] });
    const response = await POST(request(JSON.stringify({ message: "로드맵은?", mode: "normal" })));
    await expect(response.json()).resolves.toMatchObject({ warnings: [] });
  });

  it("allows a non-blocking personalization clarification only when self-reference needs it", async () => {
    orchestratorState.run.mockResolvedValueOnce({
      ...safeResult,
      answerSegments: [
        ...safeResult.answerSegments,
        { kind: "clarification", format: "paragraph", text: "내 정보를 설정하면 담당 항목을 더 정확히 찾을 수 있습니다.", referenceNumbers: [] },
      ],
      evidenceStatus: "partial",
      warnings: ["personalization_needed"],
    });
    const response = await POST(request(JSON.stringify({ message: "내 할 일은?", mode: "normal" })));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.warnings).toContain("personalization_needed");
    expect(body.answerSegments).toContainEqual(expect.objectContaining({ kind: "clarification", referenceNumbers: [] }));
  });

  it("returns partial-index answers with a warning instead of lowering them to an error", async () => {
    orchestratorState.run.mockResolvedValueOnce({
      ...safeResult,
      evidenceStatus: "partial",
      warnings: ["index_partial"],
    });
    const response = await POST(request(JSON.stringify({ message: "로드맵은?", mode: "deep" })));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      evidenceStatus: "partial",
      warnings: ["index_partial"],
    });
  });
});
