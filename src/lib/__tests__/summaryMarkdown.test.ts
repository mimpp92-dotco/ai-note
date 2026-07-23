import { describe, expect, it } from "vitest";

import type { Summary } from "@/domain/summary";
import { formatMeetingMarkdown, formatSummaryMarkdown } from "@/lib/summaryMarkdown";

// A summary with a mix of populated and empty sections, so tests can assert both
// that non-empty sections render and empty ones are dropped.
function makeSummary(overrides: Partial<Summary> = {}): Summary {
  return {
    title: "주간 회의 2026-07-08",
    topicSlug: "weekly-sync",
    oneLine: "이번 주 우선순위를 정렬했다.",
    purpose: "우선순위 정렬",
    participants: [],
    highlights: ["온보딩 개선 착수", "재고 견적 완료"],
    discussion: [],
    decisions: ["온보딩을 최우선으로 진행한다."],
    actionItems: [{ owner: "딜런", task: "초안 작성", due: "2026-07-10" }],
    risks: [],
    followups: [],
    ...overrides,
  };
}

describe("formatSummaryMarkdown", () => {
  it("keeps the default fresh output byte-compatible", () => {
    expect(formatSummaryMarkdown(makeSummary(), ["딜런"])).toBe(
      "# 주간 회의 2026-07-08\n\n"
      + "> 이번 주 우선순위를 정렬했다.\n\n"
      + "**목적:** 우선순위 정렬\n**참석자:** 딜런\n\n"
      + "## 핵심\n- 온보딩 개선 착수\n- 재고 견적 완료\n\n\n"
      + "## 결정사항\n- 온보딩을 최우선으로 진행한다.\n\n\n"
      + "## 액션 아이템\n- [ ] 초안 작성 — 딜런 (2026-07-10)\n",
    );
  });

  it("omits empty sections and renders non-empty ones as bullets", () => {
    const md = formatSummaryMarkdown(makeSummary());

    // empty arrays → their headings never appear
    expect(md).not.toContain("## 논의");
    expect(md).not.toContain("## 리스크");
    expect(md).not.toContain("## 후속");

    // populated highlights + decisions render as "- " bullets under their headings
    expect(md).toContain("## 핵심\n- 온보딩 개선 착수\n- 재고 견적 완료");
    expect(md).toContain("## 결정사항\n- 온보딩을 최우선으로 진행한다.");
  });

  it("renders action items as task — owner (due) checkboxes", () => {
    const md = formatSummaryMarkdown(makeSummary());
    expect(md).toContain("## 액션 아이템");
    expect(md).toContain("- [ ] 초안 작성 — 딜런 (2026-07-10)");
  });

  it("includes a 참석자 line only when participants are passed", () => {
    expect(formatSummaryMarkdown(makeSummary(), ["딜런", "지훈"])).toContain(
      "**참석자:** 딜런, 지훈",
    );
    expect(formatSummaryMarkdown(makeSummary())).not.toContain("**참석자:**");
    expect(formatSummaryMarkdown(makeSummary(), [])).not.toContain("**참석자:**");
  });

  it("adds an explicit freshness warning only for an outdated summary", () => {
    const fresh = formatSummaryMarkdown(makeSummary(), ["딜런"]);
    const outdated = formatSummaryMarkdown(makeSummary(), ["딜런"], {
      summaryOutdated: true,
    });
    const warning = "현재 스크립트 변경 후 회의록 요약이 갱신되지 않음";

    expect(fresh).not.toContain(warning);
    expect(outdated).toContain(warning);
    expect(outdated.indexOf(warning)).toBeLessThan(outdated.indexOf("이번 주 우선순위를 정렬했다."));
  });

  it("renders a manual body verbatim without rebuilding structured headings", () => {
    const body = "사용자가 지울 수 있는 제목\n\n- 자유 bullet\n\n결정사항\n직접 쓴 내용";
    const summary = makeSummary({
      title: "수동 회의",
      body,
      oneLine: "",
      purpose: "",
      highlights: [],
      discussion: [],
      decisions: [],
      actionItems: [],
      risks: [],
      followups: [],
    });

    expect(formatSummaryMarkdown(summary, ["현재 참석자"], {
      summaryOutdated: true,
    })).toBe(
      "# 수동 회의\n\n"
      + "> ⚠️ 현재 스크립트 변경 후 회의록 요약이 갱신되지 않음\n\n"
      + "**참석자:** 현재 참석자\n\n"
      + `${body}\n`,
    );
  });
});

describe("formatMeetingMarkdown", () => {
  it("appends the full transcript after the summary output", () => {
    const transcript = "안녕하세요. 회의를 시작합니다.\n두 번째 줄입니다.";
    const md = formatMeetingMarkdown(makeSummary(), transcript, ["딜런"]);

    // summary content is present (title + participants line)
    expect(md).toContain("# 주간 회의 2026-07-08");
    expect(md).toContain("**참석자:** 딜런");

    // transcript section is appended verbatim
    expect(md).toContain("## 전체 전사");
    expect(md).toContain(transcript);
  });

  it("places an outdated warning immediately after the combined document title", () => {
    const md = formatMeetingMarkdown(makeSummary(), "현재 전사", ["딜런"], {
      summaryOutdated: true,
    });
    expect(md).toMatch(
      /^# 주간 회의 2026-07-08\n\n> ⚠️ 현재 스크립트 변경 후 회의록 요약이 갱신되지 않음/u,
    );
    expect(md).toContain("## 전체 전사\n\n현재 전사\n");
  });

  it("keeps the manual body ahead of the current transcript without synthetic summary sections", () => {
    const body = "내 자유 본문\n\n직접 만든 섹션";
    const md = formatMeetingMarkdown(makeSummary({
      body,
      oneLine: "",
      purpose: "",
      highlights: [],
      discussion: [],
      decisions: [],
      actionItems: [],
      risks: [],
      followups: [],
    }), "현재 전사", ["현재 참석자"]);

    expect(md).toContain(`**참석자:** 현재 참석자\n\n${body}\n\n## 전체 전사`);
    expect(md).not.toContain("## 핵심");
    expect(md).not.toContain("## 결정사항");
  });
});
