// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  CORRECTION_CHUNK_HARD_CAP_CHARS,
  CORRECTION_CHUNK_TARGET_CHARS,
  assertCorrectionChunkPlan,
  createCorrectionChunkPlan,
} from "@/lib/correctionChunks";

const codePoints = (value: string): number => Array.from(value).length;

describe("deterministic correction chunk planner", () => {
  it("covers every source character exactly once in stable source order", () => {
    const line = (marker: string) =>
      `${marker}${"가".repeat(Math.floor(CORRECTION_CHUNK_TARGET_CHARS * 0.58))}\n`;
    const raw = [line("A"), line("B"), line("C"), line("D")].join("");
    const segments = ["A", "B", "C", "D"].map((marker, index) => ({
      start: index,
      end: index + 1,
      text: raw.split("\n")[index]!,
    }));

    const first = createCorrectionChunkPlan(raw, segments);
    const second = createCorrectionChunkPlan(raw, segments);

    expect(first).toEqual(second);
    expect(first.chunks.length).toBeGreaterThan(1);
    expect(first.chunks.map((chunk) => chunk.index)).toEqual(
      first.chunks.map((_, index) => index),
    );
    expect(first.chunks.map((chunk) => chunk.target).join("")).toBe(raw);
    expect(first.chunks[0]?.targetStart).toBe(0);
    expect(first.chunks.at(-1)?.targetEnd).toBe(raw.length);
    expect(new Set(first.chunks.map((chunk) => chunk.id)).size).toBe(
      first.chunks.length,
    );
    expect(first.planSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => assertCorrectionChunkPlan(raw, first)).not.toThrow();
  });

  it("uses natural line boundaries until one source unit alone exceeds the hard cap", () => {
    const shortLine = `${"나".repeat(
      Math.floor(CORRECTION_CHUNK_TARGET_CHARS * 0.45),
    )}\n`;
    const raw = `${shortLine}${shortLine}${shortLine}`;
    const plan = createCorrectionChunkPlan(raw);

    expect(plan.chunks.every((chunk) => (
      chunk.target.endsWith("\n")
      && codePoints(chunk.target) <= CORRECTION_CHUNK_HARD_CAP_CHARS
    ))).toBe(true);
    expect(plan.chunks.map((chunk) => chunk.target).join("")).toBe(raw);
  });

  it("splits an oversized Unicode segment without breaking surrogate pairs", () => {
    const raw = `시작 ${"😀".repeat(CORRECTION_CHUNK_HARD_CAP_CHARS + 37)} 끝`;

    const plan = createCorrectionChunkPlan(raw, [{
      start: 0,
      end: 1,
      text: raw,
    }]);

    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(plan.chunks.every(
      (chunk) => codePoints(chunk.target) <= CORRECTION_CHUNK_HARD_CAP_CHARS,
    )).toBe(true);
    expect(plan.chunks.map((chunk) => chunk.target).join("")).toBe(raw);
    expect(plan.chunks.some((chunk) => chunk.target.includes("\uFFFD"))).toBe(false);
  });

  it("preserves empty lines and provides bounded read-only context outside each target", () => {
    const block = (marker: string) =>
      `${marker}${"문".repeat(Math.floor(CORRECTION_CHUNK_TARGET_CHARS * 0.55))}`;
    const raw = `\n${block("첫")}\n\n${block("둘")}\r\n${block("셋")}\n`;
    const plan = createCorrectionChunkPlan(raw);

    expect(plan.chunks.map((chunk) => chunk.target).join("")).toBe(raw);
    for (const chunk of plan.chunks) {
      expect(raw.slice(chunk.targetStart, chunk.targetEnd)).toBe(chunk.target);
      expect(chunk.precedingContext).toBe(
        raw.slice(0, chunk.targetStart).slice(-chunk.precedingContext.length),
      );
      expect(chunk.followingContext).toBe(
        raw.slice(chunk.targetEnd, chunk.targetEnd + chunk.followingContext.length),
      );
    }
  });

  it.each([
    "missing",
    "overlap",
    "reordered",
  ] as const)("rejects a %s target instead of accepting a partial merge", (kind) => {
    const raw = [
      `${"가".repeat(CORRECTION_CHUNK_TARGET_CHARS - 100)}\n`,
      `${"나".repeat(CORRECTION_CHUNK_TARGET_CHARS - 100)}\n`,
      `${"다".repeat(CORRECTION_CHUNK_TARGET_CHARS - 100)}\n`,
    ].join("");
    const original = createCorrectionChunkPlan(raw);
    const chunks = original.chunks.map((chunk) => ({ ...chunk }));
    if (kind === "missing") chunks.splice(1, 1);
    if (kind === "overlap" && chunks[1]) chunks[1].targetStart -= 1;
    if (kind === "reordered") [chunks[0], chunks[1]] = [chunks[1]!, chunks[0]!];

    expect(() => assertCorrectionChunkPlan(raw, {
      ...original,
      chunks,
    })).toThrow("invalid_correction_chunk_plan");
  });
});
