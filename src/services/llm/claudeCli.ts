import { LLM_GENERATION_TIMEOUT_MS, runProcess } from "@/services/llm/exec";
import type { LlmAdapter, LlmHealth, LlmProvider, LlmSettings } from "@/services/llm/types";

// Claude Code CLI backend. `claude -p` runs non-interactively and reads the
// prompt from STDIN when piped. Summary tasks are self-contained (no tools,
// no elevated permissions), so we never pass --dangerously-skip-permissions.

export class ClaudeCliAdapter implements LlmAdapter {
  readonly provider: LlmProvider = "claude-cli";

  constructor(private readonly settings: LlmSettings) {}

  // `opts.json` is ignored: summarizeCore extracts JSON from plain text output.
  async run(prompt: string): Promise<string> {
    const args = ["-p", ...(this.settings.model ? ["--model", this.settings.model] : [])];
    const { stdout } = await runProcess("claude", args, {
      stdin: prompt,
      timeoutMs: LLM_GENERATION_TIMEOUT_MS,
    });
    return stdout.trim();
  }

  // Lightweight detection only: `claude --version` confirms the binary exists
  // without auth (mirrors codexCli). A real `claude -p` probe took 20–100s+ on a
  // cold start (global plugins/hooks) and tripped its own timeout, surfacing a
  // false "check login" even when login was fine. Auth is verified on the first
  // real summary; a failure there is reported via runSummarize's status.error.
  async health(): Promise<LlmHealth> {
    try {
      await runProcess("claude", ["--version"], { timeoutMs: 15_000 });
      return { ok: true, detail: "claude CLI available (auth verified on first summary)" };
    } catch (err) {
      if (isEnoent(err)) return { ok: false, detail: "claude CLI not found on PATH" };
      return { ok: false, detail: "claude CLI error" };
    }
  }
}

function isEnoent(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException | undefined;
  return e?.code === "ENOENT" || (e?.message?.includes("ENOENT") ?? false);
}
