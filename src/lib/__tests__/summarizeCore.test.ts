// @vitest-environment node
import { describe, expect, it } from "vitest";

import { summarySchema } from "@/domain/summarySchema";
import { extractJsonObject, summarizeCore } from "@/lib/summarizeCore";

// raw.md-style transcript: one segment per line.
const RAW = [
  "안녕하세요, 오늘 데일리 스크럼 시작하겠습니다.",
  "지난주 스프린트에서 딜러십 재고 견적 기능을 마무리했습니다.",
  "이번 주는 RIDE 온보딩 플로우를 개선할 예정입니다.",
  "메리츠캐피탈 리스 연동은 범위가 커서 다음 에픽으로 넘기겠습니다.",
].join("\n");

describe("summarizeCore", () => {
  // The core is staging-only: it returns validated payloads and owns no path or
  // canonical write capability. Publication is tested at the publisher boundary.
  it("returns a schema-valid summary and transcript from well-formed output", async () => {
    const llmSummary = JSON.stringify({
      title: "데일리 스크럼 2026-07-05",
      topicSlug: "daily-scrum-dealer-inventory",
      oneLine: "재고 견적을 마무리하고 RIDE 온보딩 개선에 착수한다.",
      purpose: "스프린트 회고와 이번 주 우선순위 정렬",
      participants: ["딜런", "지훈"], // model-picked names — must be dropped
      highlights: ["재고 견적 기능 완료", "온보딩 개선 착수"],
      discussion: ["재고 견적 기능을 완료했다.", "온보딩 이탈 지점을 논의했다."],
      decisions: ["온보딩 개선을 이번 주 최우선으로 진행한다."],
      actionItems: [{ owner: "딜런", task: "온보딩 초안 작성", due: "2026-07-08" }],
      risks: [],
      followups: [],
    });
    const result = await summarizeCore({
      title: "데일리 스크럼 2026-07-05",
      raw: RAW,
      correction: RAW,
      summaryOutput: llmSummary,
    });

    const summary = summarySchema.parse(result.summary);
    expect(result.usedFallback).toBe(false);
    expect(summary.purpose).toBe("스프린트 회고와 이번 주 우선순위 정렬");
    // participants are NEVER taken from the model — status.review is authoritative.
    expect(summary.participants).toEqual([]);
    expect(summary.actionItems[0]).toEqual({
      owner: "딜런",
      task: "온보딩 초안 작성",
      due: "2026-07-08",
    });
    expect(result.transcript).toBe(RAW);
    expect(Object.keys(result)).not.toContain("transcriptPath");
    expect(Object.keys(result)).not.toContain("summaryPath");
  });

  it("extracts JSON from a fenced code block wrapped in prose", async () => {
    const llmSummary = [
      "요약 결과입니다:",
      "```json",
      JSON.stringify({ oneLine: "한 줄", discussion: ["논의 하나"] }),
      "```",
    ].join("\n");
    const result = await summarizeCore({
      title: "회의",
      raw: RAW,
      correction: RAW,
      summaryOutput: llmSummary,
    });

    const summary = summarySchema.parse(result.summary);
    expect(result.usedFallback).toBe(false);
    expect(summary.oneLine).toBe("한 줄");
    // highlights always present — filled from discussion when the model omits them.
    expect(summary.highlights).toEqual(["논의 하나"]);
  });

  // (b) invalid JSON output → schema-compliant fallback.
  it("falls back to a schema-compliant summary when output is not valid JSON", async () => {
    const result = await summarizeCore({
      title: "회의 2026-07-05",
      raw: RAW,
      correction: RAW,
      summaryOutput: "죄송합니다. 요약을 생성하지 못했습니다.",
    });

    const summary = summarySchema.parse(result.summary);
    expect(result.usedFallback).toBe(true);
    expect(summary.purpose).toBe(""); // fallback purpose
    expect(summary.participants).toEqual([]);
    expect(summary.highlights.length).toBeGreaterThan(0); // filled from transcript
  });

  it("falls back when the output has braces but is malformed JSON", async () => {
    const result = await summarizeCore({
      title: "회의",
      raw: RAW,
      correction: RAW,
      summaryOutput: "{ oneLine: 따옴표 없는 잘못된 JSON, }",
    });

    const summary = summarySchema.parse(result.summary);
    expect(result.usedFallback).toBe(true);
    expect(summary.participants).toEqual([]);
  });

  // (c) correction under 30% of the original → keep the raw transcript.
  it("keeps the raw transcript when the correction is under 30% of original length", async () => {
    const result = await summarizeCore({
      title: "회의",
      raw: RAW,
      correction: "짧음", // far under 30% of RAW
      summaryOutput: JSON.stringify({ oneLine: "요약", discussion: ["내용"] }),
    });

    // over-edit guard: original transcript is preserved verbatim.
    expect(result.transcript).toBe(RAW);
  });

  // contamination guard: model returned its English reasoning instead of a
  // faithful correction of the Korean transcript → keep the raw STT.
  it("keeps the raw transcript when the correction is leaked model reasoning", async () => {
    const leaked = [
      "This is a summarizer worker task — I've been handed raw STT text and asked",
      "to output only the corrected transcription. The transcript is essentially",
      "degenerate. Wait — I must not add content. Let me just clean it faithfully.",
    ].join(" ");
    const result = await summarizeCore({
      title: "회의",
      raw: RAW,
      correction: leaked,
      summaryOutput: JSON.stringify({ oneLine: "요약", discussion: ["내용"] }),
    });

    expect(result.transcript).toBe(RAW);
  });

  it("uses the correction when it is a healthy length", async () => {
    const corrected = RAW.replace("RIDE", "라이드(RIDE)");
    const result = await summarizeCore({
      title: "회의",
      raw: RAW,
      correction: corrected,
      summaryOutput: JSON.stringify({ oneLine: "요약", discussion: ["내용"] }),
    });

    expect(result.transcript).toBe(corrected);
  });
});

// The tolerant extractor is shared with the chatbot envelope parser (phase 1):
// local CLIs (claude -p / codex exec) emit fenced or prose-wrapped JSON, so both
// the summary and the chat paths must salvage the JSON object rather than doing a
// bare JSON.parse on the whole output.
describe("extractJsonObject — tolerant JSON extraction", () => {
  const envelope = {
    type: "tool_calls",
    toolCalls: [{ callId: "a", name: "search_meetings", arguments: { query: "로드맵" } }],
  };
  const json = JSON.stringify(envelope);

  it("(a) extracts an envelope from a ```json fenced block", () => {
    expect(extractJsonObject(["```json", json, "```"].join("\n"))).toEqual(envelope);
  });

  it("(b) extracts JSON that follows leading prose", () => {
    expect(extractJsonObject(`네, 다음과 같이 검색하겠습니다\n${json}`)).toEqual(envelope);
  });

  it("(c) extracts JSON that has trailing text after it", () => {
    expect(extractJsonObject(`${json}\n위와 같이 도구를 호출합니다.`)).toEqual(envelope);
  });

  it("(d) parses pure JSON with no wrappers", () => {
    expect(extractJsonObject(json)).toEqual(envelope);
  });

  it("returns null when there is no JSON object to salvage", () => {
    expect(extractJsonObject("죄송합니다, 답변을 생성하지 못했습니다.")).toBeNull();
  });
});
