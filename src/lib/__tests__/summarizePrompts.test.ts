// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Glossary } from "@/domain/glossary";
import { buildCorrectionPrompt, buildSummaryPrompt, CORRECTION_RULES } from "@/lib/summarizePrompts";

const g = (over: Partial<Glossary> = {}): Glossary => ({ terms: [], corrections: [], ...over });

describe("buildCorrectionPrompt", () => {
  it("injects terms into the domain-term rule", () => {
    const p = buildCorrectionPrompt("원문", g({ terms: ["OKR", "프로덕트 로드맵"] }));
    expect(p).toContain("다음 도메인 용어를 우선 적용해 교정하세요: OKR, 프로덕트 로드맵");
  });

  it("adds a from→to corrections rule when corrections exist", () => {
    const p = buildCorrectionPrompt("원문", g({ corrections: [{ from: "김민중", to: "김민준" }] }));
    expect(p).toContain("김민중→김민준");
    expect(p).toContain("왼쪽(잘못 인식)을 오른쪽(올바른 표기)으로 교정");
  });

  it("omits the corrections rule when there are none", () => {
    expect(buildCorrectionPrompt("원문", g())).not.toContain("왼쪽(잘못 인식)을 오른쪽(올바른 표기)으로 교정");
  });

  it("always includes the number/date arabic-normalization exception to rule 2", () => {
    expect(buildCorrectionPrompt("원문", g())).toContain(CORRECTION_RULES.numberNormalization);
  });

  it("preserves the anti-leak output-only rule", () => {
    expect(buildCorrectionPrompt("원문", g())).toContain(CORRECTION_RULES.outputOnly);
  });

  it("ends with the raw transcript under [원문]", () => {
    expect(buildCorrectionPrompt("여기가 원문입니다", g())).toContain("[원문]\n여기가 원문입니다");
  });
});

describe("buildSummaryPrompt", () => {
  it("does NOT inject glossary terms/corrections (correction-step only)", () => {
    const p = buildSummaryPrompt("전사 본문", "제목");
    expect(p).not.toContain("도메인 용어");
    expect(p).toContain("[전사]");
  });

  it("includes all 40,001 transcript characters without a truncation notice", () => {
    const transcript = `${"가".repeat(40_000)}끝`;
    const prompt = buildSummaryPrompt(transcript, "긴 회의");

    expect(prompt).toContain(`[전사]\n${transcript}`);
    expect(prompt.endsWith(transcript)).toBe(true);
    expect(prompt).not.toContain("앞부분만 반영");
  });

  it("keeps generated participants empty because review state owns attendees", () => {
    expect(buildSummaryPrompt("전사", "회의")).toContain(
      "participants는 반드시 빈 배열",
    );
  });
});

// Drift guard: summarizePrompts.ts is canonical and ARCHITECTURE mirrors it.
// The manual command is API-only and intentionally owns no prompt text.
describe("correction-prompt drift guard", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8");

  it("docs/ARCHITECTURE.md mirrors the canonical rules verbatim", () => {
    const doc = read("docs/ARCHITECTURE.md");
    expect(doc).toContain(CORRECTION_RULES.numberNormalization);
    expect(doc).toContain(CORRECTION_RULES.outputOnly);
  });

  it("the /meeting-summarize skill delegates to the app and contains no prompt mirror", () => {
    const doc = read(".claude/commands/meeting-summarize.md");
    expect(doc).toContain("scripts/meeting-summarize.mjs");
    expect(doc).not.toContain(CORRECTION_RULES.numberNormalization);
    expect(doc).not.toContain(CORRECTION_RULES.outputOnly);
  });
});
