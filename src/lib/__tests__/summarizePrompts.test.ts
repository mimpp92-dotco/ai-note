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
});

// Drift guard: the correction prompt is mirrored in docs and the manual skill.
// summarizePrompts.ts is the canonical copy — assert the mirrors quote it verbatim
// so they can never silently drift again.
describe("correction-prompt drift guard", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8");

  it("docs/ARCHITECTURE.md mirrors the canonical rules verbatim", () => {
    const doc = read("docs/ARCHITECTURE.md");
    expect(doc).toContain(CORRECTION_RULES.numberNormalization);
    expect(doc).toContain(CORRECTION_RULES.outputOnly);
  });

  it("the /meeting-summarize skill mirrors the canonical rules verbatim", () => {
    const doc = read(".claude/commands/meeting-summarize.md");
    expect(doc).toContain(CORRECTION_RULES.numberNormalization);
    expect(doc).toContain(CORRECTION_RULES.outputOnly);
  });
});
