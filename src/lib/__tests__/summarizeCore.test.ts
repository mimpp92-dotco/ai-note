// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { summarySchema } from "@/domain/summarySchema";
import { summarizeCore } from "@/lib/summarizeCore";

// raw.md-style transcript: one segment per line.
const RAW = [
  "안녕하세요, 오늘 데일리 스크럼 시작하겠습니다.",
  "지난주 스프린트에서 딜러십 재고 견적 기능을 마무리했습니다.",
  "이번 주는 RIDE 온보딩 플로우를 개선할 예정입니다.",
  "메리츠캐피탈 리스 연동은 범위가 커서 다음 에픽으로 넘기겠습니다.",
].join("\n");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "summarize-core-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function targets() {
  return {
    transcriptPath: join(dir, "transcript.md"),
    summaryPath: join(dir, "summary.json"),
  };
}

describe("summarizeCore", () => {
  // (a) happy LLM output → schema-valid summary.json + transcript.md written.
  it("writes a schema-valid summary.json and transcript.md from well-formed output", async () => {
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
    const { transcriptPath, summaryPath } = targets();

    const result = await summarizeCore({
      title: "데일리 스크럼 2026-07-05",
      raw: RAW,
      correction: RAW,
      summaryOutput: llmSummary,
      transcriptPath,
      summaryPath,
    });

    // summary.json must round-trip through the contract schema.
    const summary = summarySchema.parse(
      JSON.parse(await readFile(summaryPath, "utf-8")),
    );
    expect(result.usedFallback).toBe(false);
    expect(summary.purpose).toBe("스프린트 회고와 이번 주 우선순위 정렬");
    // participants are NEVER taken from the model — status.review is authoritative.
    expect(summary.participants).toEqual([]);
    expect(summary.actionItems[0]).toEqual({
      owner: "딜런",
      task: "온보딩 초안 작성",
      due: "2026-07-08",
    });
    expect(await readFile(transcriptPath, "utf-8")).toBe(RAW);
  });

  it("extracts JSON from a fenced code block wrapped in prose", async () => {
    const llmSummary = [
      "요약 결과입니다:",
      "```json",
      JSON.stringify({ oneLine: "한 줄", discussion: ["논의 하나"] }),
      "```",
    ].join("\n");
    const { transcriptPath, summaryPath } = targets();

    const result = await summarizeCore({
      title: "회의",
      raw: RAW,
      correction: RAW,
      summaryOutput: llmSummary,
      transcriptPath,
      summaryPath,
    });

    const summary = summarySchema.parse(
      JSON.parse(await readFile(summaryPath, "utf-8")),
    );
    expect(result.usedFallback).toBe(false);
    expect(summary.oneLine).toBe("한 줄");
    // highlights always present — filled from discussion when the model omits them.
    expect(summary.highlights).toEqual(["논의 하나"]);
  });

  // (b) invalid JSON output → schema-compliant fallback.
  it("falls back to a schema-compliant summary when output is not valid JSON", async () => {
    const { transcriptPath, summaryPath } = targets();

    const result = await summarizeCore({
      title: "회의 2026-07-05",
      raw: RAW,
      correction: RAW,
      summaryOutput: "죄송합니다. 요약을 생성하지 못했습니다.",
      transcriptPath,
      summaryPath,
    });

    const summary = summarySchema.parse(
      JSON.parse(await readFile(summaryPath, "utf-8")),
    );
    expect(result.usedFallback).toBe(true);
    expect(summary.purpose).toBe(""); // fallback purpose
    expect(summary.participants).toEqual([]);
    expect(summary.highlights.length).toBeGreaterThan(0); // filled from transcript
  });

  it("falls back when the output has braces but is malformed JSON", async () => {
    const { transcriptPath, summaryPath } = targets();

    const result = await summarizeCore({
      title: "회의",
      raw: RAW,
      correction: RAW,
      summaryOutput: "{ oneLine: 따옴표 없는 잘못된 JSON, }",
      transcriptPath,
      summaryPath,
    });

    const summary = summarySchema.parse(
      JSON.parse(await readFile(summaryPath, "utf-8")),
    );
    expect(result.usedFallback).toBe(true);
    expect(summary.participants).toEqual([]);
  });

  // (c) correction under 30% of the original → keep the raw transcript.
  it("keeps the raw transcript when the correction is under 30% of original length", async () => {
    const { transcriptPath, summaryPath } = targets();

    await summarizeCore({
      title: "회의",
      raw: RAW,
      correction: "짧음", // far under 30% of RAW
      summaryOutput: JSON.stringify({ oneLine: "요약", discussion: ["내용"] }),
      transcriptPath,
      summaryPath,
    });

    // over-edit guard: original transcript is preserved verbatim.
    expect(await readFile(transcriptPath, "utf-8")).toBe(RAW);
  });

  it("uses the correction when it is a healthy length", async () => {
    const corrected = RAW.replace("RIDE", "라이드(RIDE)");
    const { transcriptPath, summaryPath } = targets();

    await summarizeCore({
      title: "회의",
      raw: RAW,
      correction: corrected,
      summaryOutput: JSON.stringify({ oneLine: "요약", discussion: ["내용"] }),
      transcriptPath,
      summaryPath,
    });

    expect(await readFile(transcriptPath, "utf-8")).toBe(corrected);
  });
});
