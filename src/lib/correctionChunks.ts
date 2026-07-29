import { createHash } from "node:crypto";

export const CORRECTION_CHUNK_TARGET_CHARS = 6_000;
export const CORRECTION_CHUNK_HARD_CAP_CHARS = 8_000;
export const CORRECTION_CHUNK_CONTEXT_CHARS = 800;

export interface CorrectionSourceSegment {
  start: number;
  end: number;
  text: string;
}

export interface CorrectionChunk {
  id: string;
  index: number;
  targetStart: number;
  targetEnd: number;
  targetSha256: string;
  target: string;
  precedingContext: string;
  followingContext: string;
}

export interface CorrectionChunkPlan {
  schemaVersion: 1;
  sourceSha256: string;
  sourceLength: number;
  chunks: CorrectionChunk[];
  planSha256: string;
}

interface SourceRange {
  start: number;
  end: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pointLength(value: string): number {
  return Array.from(value).length;
}

function takeFirstPoints(value: string, count: number): string {
  return Array.from(value).slice(0, count).join("");
}

function takeLastPoints(value: string, count: number): string {
  return Array.from(value).slice(-count).join("");
}

function lineRanges(raw: string): SourceRange[] {
  if (raw.length === 0) return [];
  const ranges: SourceRange[] = [];
  const newline = /\r\n|\n|\r/gu;
  let start = 0;
  for (const match of raw.matchAll(newline)) {
    const end = (match.index ?? 0) + match[0].length;
    ranges.push({ start, end });
    start = end;
  }
  if (start < raw.length) ranges.push({ start, end: raw.length });
  return ranges;
}

function segmentRanges(
  raw: string,
  segments: readonly CorrectionSourceSegment[],
): SourceRange[] | null {
  const texts = segments
    .filter((segment) => segment.text.length > 0)
    .map((segment) => segment.text);
  if (texts.length === 0) return null;
  const trailing = raw.endsWith("\n") ? "\n" : "";
  if (`${texts.join("\n")}${trailing}` !== raw) return null;

  const ranges: SourceRange[] = [];
  let start = 0;
  for (let index = 0; index < texts.length; index += 1) {
    const separatorLength = index < texts.length - 1 || trailing ? 1 : 0;
    const end = start + texts[index]!.length + separatorLength;
    ranges.push({ start, end });
    start = end;
  }
  return ranges;
}

function safeSplitPoint(value: string): number {
  const points = Array.from(value);
  if (points.length <= CORRECTION_CHUNK_HARD_CAP_CHARS) return value.length;
  const floor = Math.floor(CORRECTION_CHUNK_HARD_CAP_CHARS * 0.6);
  for (let index = CORRECTION_CHUNK_HARD_CAP_CHARS; index >= floor; index -= 1) {
    if (/[\s.!?。！？,，;；:：)]/u.test(points[index - 1] ?? "")) {
      return points.slice(0, index).join("").length;
    }
  }
  return points.slice(0, CORRECTION_CHUNK_HARD_CAP_CHARS).join("").length;
}

function splitOversizedRange(raw: string, range: SourceRange): SourceRange[] {
  const ranges: SourceRange[] = [];
  let start = range.start;
  while (
    pointLength(raw.slice(start, range.end))
    > CORRECTION_CHUNK_HARD_CAP_CHARS
  ) {
    const relativeEnd = safeSplitPoint(raw.slice(start, range.end));
    ranges.push({ start, end: start + relativeEnd });
    start += relativeEnd;
  }
  if (start < range.end) ranges.push({ start, end: range.end });
  return ranges;
}

function groupRanges(raw: string, ranges: readonly SourceRange[]): SourceRange[] {
  const grouped: SourceRange[] = [];
  let current: SourceRange | null = null;
  let currentLength = 0;
  for (const range of ranges.flatMap((item) => splitOversizedRange(raw, item))) {
    const length = pointLength(raw.slice(range.start, range.end));
    if (
      current
      && currentLength + length > CORRECTION_CHUNK_TARGET_CHARS
    ) {
      grouped.push(current);
      current = null;
      currentLength = 0;
    }
    if (!current) current = { ...range };
    else current.end = range.end;
    currentLength += length;
  }
  if (current) grouped.push(current);
  return grouped;
}

function chunkId(input: {
  index: number;
  targetStart: number;
  targetEnd: number;
  targetSha256: string;
}): string {
  return `chunk-${input.index}-${sha256(JSON.stringify(input)).slice(0, 16)}`;
}

function planIdentity(plan: Omit<CorrectionChunkPlan, "planSha256">): string {
  return sha256(JSON.stringify({
    schemaVersion: plan.schemaVersion,
    sourceSha256: plan.sourceSha256,
    sourceLength: plan.sourceLength,
    chunks: plan.chunks.map((chunk) => ({
      id: chunk.id,
      index: chunk.index,
      targetStart: chunk.targetStart,
      targetEnd: chunk.targetEnd,
      targetSha256: chunk.targetSha256,
    })),
  }));
}

export function createCorrectionChunkPlan(
  raw: string,
  segments: readonly CorrectionSourceSegment[] = [],
): CorrectionChunkPlan {
  const naturalRanges = segmentRanges(raw, segments) ?? lineRanges(raw);
  const chunks = groupRanges(raw, naturalRanges).map((range, index) => {
    const target = raw.slice(range.start, range.end);
    const targetSha256 = sha256(target);
    const identity = {
      index,
      targetStart: range.start,
      targetEnd: range.end,
      targetSha256,
    };
    return {
      id: chunkId(identity),
      ...identity,
      target,
      precedingContext: takeLastPoints(
        raw.slice(0, range.start),
        CORRECTION_CHUNK_CONTEXT_CHARS,
      ),
      followingContext: takeFirstPoints(
        raw.slice(range.end),
        CORRECTION_CHUNK_CONTEXT_CHARS,
      ),
    };
  });
  const base = {
    schemaVersion: 1 as const,
    sourceSha256: sha256(raw),
    sourceLength: raw.length,
    chunks,
  };
  const plan = { ...base, planSha256: planIdentity(base) };
  assertCorrectionChunkPlan(raw, plan);
  return plan;
}

export function assertCorrectionChunkPlan(
  raw: string,
  plan: CorrectionChunkPlan,
): void {
  const fail = (): never => {
    throw new Error("invalid_correction_chunk_plan");
  };
  if (
    plan.schemaVersion !== 1
    || plan.sourceSha256 !== sha256(raw)
    || plan.sourceLength !== raw.length
    || (raw.length > 0 && plan.chunks.length === 0)
  ) fail();

  let cursor = 0;
  for (let index = 0; index < plan.chunks.length; index += 1) {
    const chunk = plan.chunks[index]!;
    const identity = {
      index,
      targetStart: chunk.targetStart,
      targetEnd: chunk.targetEnd,
      targetSha256: chunk.targetSha256,
    };
    if (
      chunk.index !== index
      || chunk.targetStart !== cursor
      || chunk.targetEnd <= chunk.targetStart
      || chunk.targetEnd > raw.length
      || raw.slice(chunk.targetStart, chunk.targetEnd) !== chunk.target
      || sha256(chunk.target) !== chunk.targetSha256
      || chunk.id !== chunkId(identity)
      || pointLength(chunk.target) > CORRECTION_CHUNK_HARD_CAP_CHARS
      || chunk.precedingContext !== takeLastPoints(
        raw.slice(0, chunk.targetStart),
        CORRECTION_CHUNK_CONTEXT_CHARS,
      )
      || chunk.followingContext !== takeFirstPoints(
        raw.slice(chunk.targetEnd),
        CORRECTION_CHUNK_CONTEXT_CHARS,
      )
    ) fail();
    cursor = chunk.targetEnd;
  }
  if (
    cursor !== raw.length
    || plan.planSha256 !== planIdentity({
      schemaVersion: 1,
      sourceSha256: plan.sourceSha256,
      sourceLength: plan.sourceLength,
      chunks: plan.chunks,
    })
  ) fail();
}
