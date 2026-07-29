import { createHash } from "node:crypto";

import type { Glossary } from "@/domain/glossary";
import {
  assertCorrectionChunkPlan,
  type CorrectionChunk,
  type CorrectionChunkPlan,
} from "@/lib/correctionChunks";
import { buildCorrectionPrompt } from "@/lib/summarizePrompts";
import type { LlmProvider } from "@/services/llm/types";

export const FAST_CORRECTION_PROMPT_VERSION = "correction-fast-v1";

export interface CompletedCorrectionChunk {
  index: number;
  chunkId: string;
  inputSha256: string;
  outputSha256: string;
  correctedText: string;
}

export interface CorrectionRunnerInput {
  plan: CorrectionChunkPlan;
  provider: LlmProvider;
  glossary: Glossary;
  completedChunks?: readonly CompletedCorrectionChunk[];
  runChunk(prompt: string, chunk: CorrectionChunk): Promise<string>;
  onChunkCompleted?(
    chunk: CompletedCorrectionChunk,
    completed: readonly CompletedCorrectionChunk[],
  ): Promise<void>;
}

export interface CorrectionRunnerResult {
  transcript: string;
  chunks: CompletedCorrectionChunk[];
  freshCalls: number;
}

export class CorrectionRunnerError extends Error {
  readonly code:
    | "chunk_failed"
    | "chunk_empty"
    | "chunk_length_invalid"
    | "chunk_script_contamination"
    | "chunk_context_contamination"
    | "chunk_identity_invalid"
    | "merge_invalid";

  constructor(code: CorrectionRunnerError["code"]) {
    super(code);
    this.name = "CorrectionRunnerError";
    this.code = code;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stripWrappers(value: string): string {
  let text = value.trim();
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*)\n```$/u);
  if (fence) text = fence[1].trim();
  text = text.replace(
    /^(교정(된)?\s*전사|corrected transcript|결과)\s*[:：]\s*\n?/iu,
    "",
  );
  return text.trim();
}

function scriptCounts(value: string): { latin: number; cjk: number } {
  let latin = 0;
  let cjk = 0;
  for (const character of value) {
    if (/[A-Za-z]/u.test(character)) latin += 1;
    else if (/[가-힣぀-ヿ一-鿿]/u.test(character)) cjk += 1;
  }
  return { latin, cjk };
}

function contaminated(source: string, correction: string): boolean {
  const sourceCounts = scriptCounts(source);
  const correctionCounts = scriptCounts(correction);
  const sourceTotal = sourceCounts.latin + sourceCounts.cjk;
  const correctionTotal = correctionCounts.latin + correctionCounts.cjk;
  if (sourceTotal < 10 || correctionTotal < 10) return false;
  return sourceCounts.latin / sourceTotal < 0.2
    && correctionCounts.latin / correctionTotal > 0.4;
}

function copiedContext(chunk: CorrectionChunk, cleaned: string): boolean {
  const target = chunk.target.trim();
  const preceding = chunk.precedingContext.trim();
  const following = chunk.followingContext.trim();
  return (
    preceding.length >= 16
    && cleaned.startsWith(preceding)
    && !target.startsWith(preceding)
  ) || (
    following.length >= 16
    && cleaned.endsWith(following)
    && !target.endsWith(following)
  );
}

function edgeSeparators(value: string): { leading: string; trailing: string } {
  return {
    leading: value.match(/^(?:(?:\r\n|\n|\r)+)/u)?.[0] ?? "",
    trailing: value.match(/(?:(?:\r\n|\n|\r)+)$/u)?.[0] ?? "",
  };
}

function validateChunkOutput(chunk: CorrectionChunk, output: string): string {
  const cleaned = stripWrappers(output);
  if (!cleaned) throw new CorrectionRunnerError("chunk_empty");
  if (copiedContext(chunk, cleaned)) {
    throw new CorrectionRunnerError("chunk_context_contamination");
  }
  const sourceLength = Array.from(chunk.target.trim()).length;
  const outputLength = Array.from(cleaned).length;
  if (
    sourceLength === 0
    || outputLength < Math.max(8, Math.floor(sourceLength * 0.3))
    || outputLength > Math.max(32, Math.ceil(sourceLength * 2.5))
  ) {
    throw new CorrectionRunnerError("chunk_length_invalid");
  }
  if (contaminated(chunk.target, cleaned)) {
    throw new CorrectionRunnerError("chunk_script_contamination");
  }

  const separators = edgeSeparators(chunk.target);
  return `${separators.leading}${cleaned}${separators.trailing}`;
}

function buildChunkPrompt(chunk: CorrectionChunk, glossary: Glossary): string {
  const base = buildCorrectionPrompt(chunk.target, glossary);
  return base.replace(
    "[원문]",
    `아래 두 문맥은 읽기 전용입니다. 교정 결과에 포함하지 마세요.
[읽기 전용 앞 문맥]
${chunk.precedingContext}
[읽기 전용 뒤 문맥]
${chunk.followingContext}

[원문]`,
  );
}

function exactReusableChunk(
  chunk: CompletedCorrectionChunk,
  target: CorrectionChunk | undefined,
): boolean {
  return target !== undefined
    && chunk.index === target.index
    && chunk.chunkId === target.id
    && chunk.inputSha256 === target.targetSha256
    && chunk.outputSha256 === sha256(chunk.correctedText);
}

function concurrencyFor(provider: LlmProvider): number {
  return provider === "ollama" ? 1 : 2;
}

export async function runCorrectionChunks(
  input: CorrectionRunnerInput,
): Promise<CorrectionRunnerResult> {
  const raw = input.plan.chunks.map((chunk) => chunk.target).join("");
  assertCorrectionChunkPlan(raw, input.plan);

  const results = new Map<number, CompletedCorrectionChunk>();
  const observedIndexes = new Set<number>();
  for (const completed of input.completedChunks ?? []) {
    if (observedIndexes.has(completed.index)) {
      throw new CorrectionRunnerError("chunk_identity_invalid");
    }
    observedIndexes.add(completed.index);
    const target = input.plan.chunks[completed.index];
    if (!exactReusableChunk(completed, target)) continue;
    const normalized = validateChunkOutput(target!, completed.correctedText);
    if (normalized !== completed.correctedText) {
      throw new CorrectionRunnerError("chunk_identity_invalid");
    }
    results.set(completed.index, { ...completed });
  }

  const pending = input.plan.chunks.filter((chunk) => !results.has(chunk.index));
  let cursor = 0;
  let freshCalls = 0;
  let failure: CorrectionRunnerError | null = null;
  let commitTail: Promise<void> = Promise.resolve();

  const record = async (completed: CompletedCorrectionChunk): Promise<void> => {
    const commit = commitTail.then(async () => {
      results.set(completed.index, completed);
      const ordered = [...results.values()].sort((left, right) => (
        left.index - right.index
      ));
      await input.onChunkCompleted?.(completed, ordered);
    });
    commitTail = commit.catch((error) => {
      if (!failure) {
        failure = error instanceof CorrectionRunnerError
          ? error
          : new CorrectionRunnerError("chunk_failed");
      }
    });
    await commitTail;
  };

  const worker = async (): Promise<void> => {
    while (!failure) {
      const pendingIndex = cursor;
      cursor += 1;
      const chunk = pending[pendingIndex];
      if (!chunk) return;
      freshCalls += 1;
      let output: string;
      try {
        output = await input.runChunk(
          buildChunkPrompt(chunk, input.glossary),
          chunk,
        );
      } catch {
        if (!failure) failure = new CorrectionRunnerError("chunk_failed");
        return;
      }
      let correctedText: string;
      try {
        correctedText = validateChunkOutput(chunk, output);
      } catch (error) {
        if (!failure) {
          failure = error instanceof CorrectionRunnerError
            ? error
            : new CorrectionRunnerError("chunk_failed");
        }
        return;
      }
      await record({
        index: chunk.index,
        chunkId: chunk.id,
        inputSha256: chunk.targetSha256,
        outputSha256: sha256(correctedText),
        correctedText,
      });
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(concurrencyFor(input.provider), pending.length) },
      () => worker(),
    ),
  );
  await commitTail;
  if (failure) throw failure;

  const chunks = [...results.values()].sort((left, right) => left.index - right.index);
  if (
    chunks.length !== input.plan.chunks.length
    || chunks.some((chunk, index) => !exactReusableChunk(
      chunk,
      input.plan.chunks[index],
    ))
  ) {
    throw new CorrectionRunnerError("merge_invalid");
  }
  const transcript = chunks.map((chunk) => chunk.correctedText).join("");
  const sourceLength = Array.from(raw.trim()).length;
  const outputLength = Array.from(transcript.trim()).length;
  if (
    sourceLength === 0
    || outputLength < Math.max(8, Math.floor(sourceLength * 0.3))
    || outputLength > Math.max(32, Math.ceil(sourceLength * 2.5))
    || contaminated(raw, transcript)
  ) {
    throw new CorrectionRunnerError("merge_invalid");
  }
  return { transcript, chunks, freshCalls };
}
