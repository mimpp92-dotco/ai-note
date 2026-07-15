import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { editableSummarySchema, summarySchema } from "@/domain/summarySchema";

function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(process.cwd(), "fixtures", name), "utf-8"),
  );
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
