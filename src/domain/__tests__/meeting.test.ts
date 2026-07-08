import { describe, expect, it } from "vitest";

import {
  assertTransition,
  canTransition,
  MEETING_STATUSES,
} from "@/domain/meeting";

describe("meeting FSM transition guard", () => {
  it("allows the canonical forward lifecycle", () => {
    expect(canTransition("recording", "recorded")).toBe(true);
    expect(canTransition("recorded", "transcribing")).toBe(true);
    expect(canTransition("transcribing", "transcribed")).toBe(true);
    expect(canTransition("transcribed", "summarizing")).toBe(true);
    expect(canTransition("summarizing", "summarized")).toBe(true);
  });

  it("allows retry re-entry into a prior processing state", () => {
    expect(canTransition("transcribed", "transcribing")).toBe(true);
    expect(canTransition("summarizing", "transcribed")).toBe(true);
  });

  it("rejects skips and backward jumps", () => {
    expect(canTransition("recording", "transcribing")).toBe(false);
    expect(canTransition("transcribing", "summarizing")).toBe(false);
    expect(canTransition("recorded", "recording")).toBe(false);
    expect(canTransition("transcribed", "recorded")).toBe(false);
    expect(canTransition("summarized", "recording")).toBe(false);
    expect(canTransition("summarized", "summarizing")).toBe(false);
  });

  it("assertTransition throws on an illegal transition and is silent on a legal one", () => {
    expect(() => assertTransition("recording", "transcribing")).toThrow();
    expect(() => assertTransition("recording", "recorded")).not.toThrow();
  });

  it("exposes all six contract states", () => {
    expect(MEETING_STATUSES).toEqual([
      "recording",
      "recorded",
      "transcribing",
      "transcribed",
      "summarizing",
      "summarized",
    ]);
  });
});
