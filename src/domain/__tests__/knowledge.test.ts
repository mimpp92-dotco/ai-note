import { describe, expect, it } from "vitest";

import {
  corpusMapSchema,
  deriveMentionedPeople,
  knowledgeCardSchema,
  knowledgeIndexStatusSchema,
} from "@/domain/knowledge";

const HASH = "a".repeat(64);
const card = {
  schemaVersion: 1,
  meetingId: "meeting-1",
  sourceHashes: { summary: HASH, transcript: "b".repeat(64) },
  content: { oneLine: "한 줄", purpose: "목적", highlights: ["핵심"], discussion: [], decisions: [], risks: [], followups: [] },
  actionItems: [{ owner: "민수", task: "문서 작성", due: "미정", searchText: "민수 문서 작성 미정" }],
  reviewParticipants: ["딜런"],
  mentionedPeople: ["민수"],
};

describe("knowledge index contracts", () => {
  it("parses a minimal valid knowledge card", () => {
    expect(knowledgeCardSchema.parse(card)).toEqual(card);
  });

  it("additively parses a manual summary body without changing old v1 cards", () => {
    const manual = {
      ...card,
      content: {
        oneLine: "",
        purpose: "",
        highlights: [],
        discussion: [],
        decisions: [],
        risks: [],
        followups: [],
        body: "사용자가 만든 제목\n\n- 자유 본문",
      },
      actionItems: [],
      mentionedPeople: [],
    };

    expect(knowledgeCardSchema.parse(manual)).toEqual(manual);
    expect(knowledgeCardSchema.parse(card)).toEqual(card);
  });

  it("limits corpus map cards to summary projections", () => {
    const projection = { meetingId: "meeting-1", oneLine: "한 줄", purpose: "목적", highlights: ["핵심"], mentionedPeople: ["민수"] };
    expect(corpusMapSchema.parse({ schemaVersion: 1, cards: [projection] }).cards[0]).toEqual(projection);
    expect(() => corpusMapSchema.parse({ schemaVersion: 1, cards: [{ ...projection, discussion: ["상세"] }] })).toThrow();
  });

  it("additively parses a bounded corpus body while preserving bodyless v1 projections", () => {
    const legacy = {
      meetingId: "meeting-1",
      oneLine: "한 줄",
      purpose: "목적",
      highlights: ["핵심"],
      mentionedPeople: ["민수"],
    };
    const manual = { ...legacy, oneLine: "", purpose: "", highlights: [], mentionedPeople: [], body: "자유 본문" };

    expect(corpusMapSchema.parse({ schemaVersion: 1, cards: [legacy] }).cards[0]).toEqual(legacy);
    expect(corpusMapSchema.parse({ schemaVersion: 1, cards: [manual] }).cards[0]).toEqual(manual);
  });

  it("keeps reviewed participants separate from deterministic mentions", () => {
    const parsed = knowledgeCardSchema.parse(card);
    expect(parsed.reviewParticipants).toEqual(["딜런"]);
    expect(parsed.mentionedPeople).toEqual(["민수"]);
  });

  it("excludes empty and placeholder action item owners from mentionedPeople", () => {
    expect(deriveMentionedPeople([
      { owner: "TODO", task: "a", due: "미정" },
      { owner: " TBD ", task: "a-2", due: "미정" },
      { owner: "-", task: "a-3", due: "미정" },
      { owner: "", task: "b", due: "미정" },
      { owner: "미정", task: "c", due: "미정" },
      { owner: "Unknown", task: "c-2", due: "미정" },
      { owner: "미지정", task: "c-3", due: "미정" },
      { owner: " 민수 ", task: "d", due: "내일" },
      { owner: "민수", task: "e", due: "금요일" },
    ])).toEqual(["민수"]);
  });

  it("requires both valid source hashes", () => {
    expect(() => knowledgeCardSchema.parse({ ...card, sourceHashes: { summary: HASH } })).toThrow();
    expect(() => knowledgeCardSchema.parse({ ...card, sourceHashes: { summary: "bad", transcript: HASH } })).toThrow();
  });

  it("strictly parses internal and public index states", () => {
    expect(knowledgeIndexStatusSchema.parse({ internalMode: "stale", state: "partial", reason: "stale" })).toEqual({ internalMode: "stale", state: "partial", reason: "stale" });
    expect(knowledgeIndexStatusSchema.parse({ internalMode: "ready", state: "ready" })).toEqual({ internalMode: "ready", state: "ready" });
    expect(() => knowledgeIndexStatusSchema.parse({ internalMode: "unknown", state: "ready" })).toThrow();
    expect(() => knowledgeIndexStatusSchema.parse({ internalMode: "missing", state: "partial", reason: "secret_path" })).toThrow();
  });
});
