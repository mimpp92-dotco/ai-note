import { runProcess } from "@/services/llm/exec";
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
    const { stdout } = await runProcess("claude", args, { stdin: prompt });
    return stdout.trim();
  }

  async health(): Promise<LlmHealth> {
    try {
      const { stdout } = await runProcess("claude", ["-p"], {
        stdin: "Reply with exactly: ok",
        timeoutMs: 25_000,
      });
      if (stdout.trim().length > 0) return { ok: true, detail: "claude CLI ready" };
      return { ok: false, detail: "claude not ready — check `claude` login" };
    } catch (err) {
      if (isEnoent(err)) return { ok: false, detail: "claude CLI not found on PATH" };
      return { ok: false, detail: "claude not ready — check `claude` login" };
    }
  }
}

function isEnoent(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException | undefined;
  return e?.code === "ENOENT" || (e?.message?.includes("ENOENT") ?? false);
}
