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
});
