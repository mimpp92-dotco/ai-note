import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { localSttGlossaryPath } from "@/lib/config";
import { meetingPaths } from "@/lib/paths";
import { readStatus, writeStatus } from "@/lib/status";
import { resolveTranscript, summarizeCore } from "@/lib/summarizeCore";
import {
  buildCorrectionPrompt,
  buildSummaryPrompt,
  formatGlossary,
} from "@/lib/summarizePrompts";
import { getConfiguredAdapter } from "@/services/llm";

// Orchestrates one meeting summarize: correction → summary → summarizeCore (which
// writes transcript.md + summary.json). The app never calls an LLM SDK — the
// configured adapter shells out to the user's own CLI/local model. Both the
// background worker and the manual retry route enter through runSummarize, so the
// in-process lock below is the only guard against concurrent runs on one id.

export const MAX_SUMMARIZE_ATTEMPTS = 3;

export type SummarizeResult =
  | { ok: true }
  | {
      ok: false;
      reason: "not_found" | "already_summarized" | "no_model" | "in_progress" | "error";
      message?: string;
    };

// Anchored on globalThis: a module-level Set isn't reliably shared across Next's
// separate server bundles, so worker and route could otherwise both run the same id.
const inflight: Set<string> = ((
  globalThis as typeof globalThis & { __aiNoteSummarizeInflight?: Set<string> }
).__aiNoteSummarizeInflight ??= new Set<string>());

export async function runSummarize(id: string): Promise<SummarizeResult> {
  if (inflight.has(id)) return { ok: false, reason: "in_progress" };
  inflight.add(id);
  try {
    const status = await readStatus(id);
    if (!status) return { ok: false, reason: "not_found" };

    const p = meetingPaths(id);
    if (existsSync(p.summary)) return { ok: false, reason: "already_summarized" };

    const adapter = await getConfiguredAdapter();
    if (!adapter) return { ok: false, reason: "no_model" };

    try {
      await writeStatus(id, { ...status, status: "summarizing", error: null });

      const raw = await readFile(p.raw, "utf-8");
      const glossary = formatGlossary(await loadGlossary());
      const title = status.title;

      const correction = await adapter.run(buildCorrectionPrompt(raw, glossary));
      // Summarize from the SAME transcript summarizeCore will persist as
      // transcript.md — the over-edit guard may keep `raw` when the correction
      // collapsed, so the summary is never built from a badly-truncated correction.
      const transcript = resolveTranscript(raw, correction);
      let summaryOutput = await adapter.run(buildSummaryPrompt(transcript, title), { json: true });

      const result = await summarizeCore({
        title,
        raw,
        correction,
        summaryOutput,
        transcriptPath: p.transcript,
        summaryPath: p.summary,
      });

      // A fallback summary means the model's JSON was unusable — retry the summary
      // step once. If the retry itself throws, keep the fallback already on disk
      // (a degraded result beats masking it as an error and looping).
      if (result.usedFallback) {
        try {
          summaryOutput = await adapter.run(buildSummaryPrompt(transcript, title), { json: true });
          await summarizeCore({
            title,
            raw,
            correction,
            summaryOutput,
            transcriptPath: p.transcript,
            summaryPath: p.summary,
          });
        } catch {
          // keep the pass-1 fallback summary.json and proceed to success.
        }
      }

      const fresh = (await readStatus(id)) ?? status;
      await writeStatus(id, { ...fresh, status: "summarized", error: null, summarizeAttempts: 0 });
      return { ok: true };
    } catch (err) {
      // Fall back to `transcribed` + a retryable error and bump the attempt count
      // so the worker backs off instead of re-spawning the CLI every poll.
      const attempts = (status.summarizeAttempts ?? 0) + 1;
      const message = String((err instanceof Error ? err.message : err) ?? err).slice(0, 300);
      await writeStatus(id, {
        ...((await readStatus(id)) ?? status),
        status: "transcribed",
        summarizeAttempts: attempts,
        error: { message, action: "retry_summary" },
      });
      return { ok: false, reason: "error", message };
    }
  } finally {
    inflight.delete(id);
  }
}

// Glossary is best-effort context for the correction prompt: any read/parse failure
// degrades to no terms rather than aborting the summarize.
async function loadGlossary(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(localSttGlossaryPath(), "utf-8"));
  } catch {
    return [];
  }
}
