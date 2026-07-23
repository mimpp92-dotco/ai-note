import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { editableSummarySchema, summarySchema } from "@/domain/summarySchema";
import {
  normalizeManualSummaryBody,
  summaryBodyFromSummary,
} from "@/lib/summaryBody";

function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(process.cwd(), "fixtures", name), "utf-8"),
  );
}

function manualSummary(body = "사용자가 직접 쓴 본문") {
  return {
    ...summarySchema.parse(loadFixture("summary.happy.json")),
    body,
    oneLine: "",
    purpose: "",
    highlights: [],
    discussion: [],
    decisions: [],
    actionItems: [],
    risks: [],
    followups: [],
  };
}

describe("summarySchema", () => {
  it("accepts the happy fixture", () => {
    expect(() => summarySchema.parse(loadFixture("summary.happy.json"))).not.toThrow();
  });

  it("accepts the fallback fixture (purpose:'' , participants:[], filled highlights)", () => {
    const parsed = summarySchema.parse(loadFixture("summary.fallback.json"));
    expect(parsed.purpose).toBe("");
    expect(parsed.participants).toEqual([]);
    expect(parsed.highlights.length).toBeGreaterThan(0);
    expect(parsed.actionItems[0]).toMatchObject({ owner: "TODO", due: "미정" });
  });

  it("defaults participants to [] when omitted (not a required field)", () => {
    const base = loadFixture("summary.happy.json") as Record<string, unknown>;
    delete base.participants;
    const parsed = summarySchema.parse(base);
    expect(parsed.participants).toEqual([]);
  });

  it("still accepts a populated participants array", () => {
    const base = loadFixture("summary.happy.json") as Record<string, unknown>;
    base.participants = ["딜런", "지훈"];
    const parsed = summarySchema.parse(base);
    expect(parsed.participants).toEqual(["딜런", "지훈"]);
  });

  it("accepts an exact manual body while keeping legacy identity fields", () => {
    const body = "사용자 제목\r\n\r\n- 첫 항목  \n";
    const legacy = summarySchema.parse(loadFixture("summary.happy.json"));
    const parsed = summarySchema.parse(manualSummary(body));

    expect(parsed.body).toBe(body);
    expect(parsed.title).toBe(legacy.title);
    expect(parsed.topicSlug).toBe(legacy.topicSlug);
    expect(parsed.participants).toEqual(legacy.participants);
  });

  it("rejects whitespace-only bodies and ambiguous body plus structured content", () => {
    expect(() => summarySchema.parse(manualSummary(" \n\t"))).toThrow();

    const ambiguousFields = [
      { oneLine: "구조화 요약" },
      { purpose: "목적" },
      { highlights: ["핵심"] },
      { discussion: ["논의"] },
      { decisions: ["결정"] },
      { actionItems: [{ owner: "담당자", task: "작업", due: "미정" }] },
      { risks: ["위험"] },
      { followups: ["후속"] },
    ];
    for (const field of ambiguousFields) {
      expect(() => summarySchema.parse({ ...manualSummary(), ...field })).toThrow();
    }
  });

  it("rejects a malformed actionItem", () => {
    const base = loadFixture("summary.happy.json") as Record<string, unknown>;
    base.actionItems = [{ owner: "딜런" }];
    expect(() => summarySchema.parse(base)).toThrow();
  });

  it("normalizes editable fields without splitting multiline list items", () => {
    const parsed = editableSummarySchema.parse({
      oneLine: " 한 줄 ",
      purpose: " 목적 ",
      highlights: [" 첫 줄\n둘째 줄 "],
      discussion: [" 논의 "],
      decisions: [" 결정 "],
      actionItems: [{ owner: "담당자", task: "할 일", due: "미정" }],
      risks: [" 위험 "],
      followups: [" 후속 "],
    });

    expect(parsed.oneLine).toBe("한 줄");
    expect(parsed.highlights).toEqual(["첫 줄\n둘째 줄"]);
    expect(parsed.discussion).toEqual(["논의"]);
  });

  it("rejects empty list items and internal or unknown summary fields", () => {
    const editable = {
      oneLine: "한 줄",
      purpose: "목적",
      highlights: ["핵심"],
      discussion: ["논의"],
      decisions: ["결정"],
      actionItems: [{ owner: "담당자", task: "할 일", due: "미정" }],
      risks: ["위험"],
      followups: ["후속"],
    };
    expect(() => editableSummarySchema.parse({ ...editable, highlights: ["  "] })).toThrow();
    expect(() => editableSummarySchema.parse({ ...editable, title: "internal" })).toThrow();
    expect(() => editableSummarySchema.parse({ ...editable, participants: [] })).toThrow();
    expect(() => editableSummarySchema.parse({ ...editable, unknown: true })).toThrow();
    expect(() => editableSummarySchema.parse({
      ...editable,
      actionItems: [{ ...editable.actionItems[0], hidden: true }],
    })).toThrow();
  });
});

describe("summary body helpers", () => {
  it("projects every structured section in deterministic reading order", () => {
    const summary = {
      title: "projection에서 제외할 제목",
      topicSlug: "excluded-topic",
      participants: ["projection에서 제외할 참석자"],
      oneLine: "한 줄 요약",
      purpose: "회의 목적",
      highlights: ["첫 핵심", "둘째 핵심\n내부 개행"],
      discussion: ["논의 A"],
      decisions: ["결정 A"],
      actionItems: [{ owner: "민지", task: "후속 작업", due: "금요일" }],
      risks: ["일정 위험"],
      followups: ["다음 회의 확인"],
    };

    expect(summaryBodyFromSummary(summary)).toBe([
      "요약\n한 줄 요약\n- 첫 핵심\n- 둘째 핵심\n내부 개행",
      "목적\n회의 목적",
      "논의 내용\n- 논의 A",
      "결정 사항\n- 결정 A",
      "액션 아이템\n- 민지 — 후속 작업 (기한: 금요일)",
      "리스크\n- 일정 위험",
      "후속 확인\n- 다음 회의 확인",
    ].join("\n\n"));
  });

  it("omits empty sections, uses exact separators, and adds no trailing LF", () => {
    const body = summaryBodyFromSummary({
      title: "제외",
      topicSlug: "excluded",
      participants: [],
      oneLine: "",
      purpose: "",
      highlights: [],
      discussion: ["첫 줄\n둘째 줄"],
      decisions: [],
      actionItems: [],
      risks: [],
      followups: [],
    });

    expect(body).toBe("논의 내용\n- 첫 줄\n둘째 줄");
    expect(body.endsWith("\n")).toBe(false);
  });

  it("returns an existing manual body without parsing or rewriting it", () => {
    const body = "제목 없는 자유 본문\n\n* 사용자가 고른 표기  ";
    expect(summaryBodyFromSummary(manualSummary(body))).toBe(body);
  });

  it("normalizes CRLF only and otherwise preserves exact manual text", () => {
    expect(normalizeManualSummaryBody("  제목\r\n- 항목  \r끝")).toBe(
      "  제목\n- 항목  \r끝",
    );
    expect(normalizeManualSummaryBody(" \r\n\t")).toBeNull();
  });
});
