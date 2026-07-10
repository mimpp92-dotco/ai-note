import { tmpdir } from "node:os";

import { LLM_GENERATION_TIMEOUT_MS, runProcess } from "@/services/llm/exec";
import type { LlmAdapter, LlmHealth, LlmProvider, LlmSettings } from "@/services/llm/types";

// Codex CLI backend — BEST-EFFORT. `codex exec` is an agentic runner (not a plain
// completion API): it emits a JSONL event stream on stdout, from which we salvage
// the model's final message. Auth is only verified on the first real summary, so
// health() just confirms the binary exists. Run read-only in a temp cwd, and skip
// the git-repo check so it works outside a repo.

export class CodexCliAdapter implements LlmAdapter {
  readonly provider: LlmProvider = "codex-cli";

  constructor(private readonly settings: LlmSettings) {}

  async run(prompt: string): Promise<string> {
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "-C",
      tmpdir(),
      ...(this.settings.model ? ["-m", this.settings.model] : []),
      "-",
    ];
    const { stdout } = await runProcess("codex", args, {
      stdin: prompt,
      timeoutMs: LLM_GENERATION_TIMEOUT_MS,
    });
    return extractFinalMessage(stdout);
  }

  async health(): Promise<LlmHealth> {
    try {
      await runProcess("codex", ["--version"], { timeoutMs: 15_000 });
      return {
        ok: true,
        detail: "codex CLI available (best-effort backend; auth verified on first summary)",
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException | undefined;
      if (e?.code === "ENOENT" || (e?.message?.includes("ENOENT") ?? false)) {
        return { ok: false, detail: "codex CLI not found on PATH" };
      }
      return { ok: false, detail: "codex not ready" };
    }
  }
}

// Tolerant JSONL parser: codex's event shape varies across versions, so we scan
// every line, skip anything unparseable, and keep the LAST non-empty text from
// events that look like the assistant's answer. If we salvage nothing, hand back
// the raw stdout — summarizeCore will still try to extract the JSON summary.
function extractFinalMessage(stdout: string): string {
  let last = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      obj = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const text = pickText(obj);
    if (text) last = text;
  }
  return last ? last.trim() : stdout.trim();
}

// Pull answer text from the handful of shapes codex has used:
//   { msg: { type: "...agent_message...", message | text } }
//   { type: "...agent_message..." | "item.completed", item: { text | content } | text }
function pickText(obj: Record<string, unknown>): string {
  const msg = obj.msg as Record<string, unknown> | undefined;
  if (msg && typeof msg === "object") {
    const type = asString(msg.type);
    if (type.includes("agent_message") || type.includes("message")) {
      const t = asString(msg.message) || asString(msg.text);
      if (t) return t;
    }
  }

  const topType = asString(obj.type);
  if (topType.includes("agent_message") || topType.includes("item.completed")) {
    const item = obj.item as Record<string, unknown> | undefined;
    const t =
      (item && typeof item === "object"
        ? asString(item.text) || asString(item.content)
        : "") || asString(obj.text);
    if (t) return t;
  }

  return "";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
