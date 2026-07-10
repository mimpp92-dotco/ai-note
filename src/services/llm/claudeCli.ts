import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { LLM_GENERATION_TIMEOUT_MS, runProcess } from "@/services/llm/exec";
import type { LlmAdapter, LlmHealth, LlmProvider, LlmSettings } from "@/services/llm/types";

// Claude Code CLI backend. `claude -p` runs non-interactively and reads the
// prompt from STDIN when piped. Summary tasks are self-contained (no tools,
// no elevated permissions), so we never pass --dangerously-skip-permissions.

// Env vars that can route `claude` to a PAID / metered backend — credentials
// (API keys, Bearer auth token) or backend redirects (Bedrock/Vertex/base URL).
// Scrubbed from the child env so an isolated summary always uses the local
// subscription OAuth login and is never silently billed to a paid API ($0
// invariant, ADR 0010). OAuth/keychain live in HOME, not env, so they survive.
const PAID_BILLING_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "OPENAI_API_KEY",
] as const;

export class ClaudeCliAdapter implements LlmAdapter {
  readonly provider: LlmProvider = "claude-cli";

  constructor(private readonly settings: LlmSettings) {}

  // `opts.json` is ignored: summarizeCore extracts JSON from plain text output.
  //
  // Isolated + self-contained (aligned with codexCli's `-C tmpdir()` pattern):
  // run in a temp cwd, never the project directory, so no workspace CLAUDE.md /
  // MCP context leaks into the correction (a past pollution bug). MCP + slash
  // commands are off for a minimal session with a clean teardown. Paid-billing
  // env vars are scrubbed (PAID_BILLING_ENV_VARS) so a subscription-OAuth CLI is
  // never silently metered to a paid API ($0 invariant); HOME/PATH stay so OAuth
  // keychain access and binary lookup still work. The transcript goes via stdin
  // only (never argv: `ps` exposure + ARG_MAX). Generation timeout stays at 600s.
  async run(prompt: string): Promise<string> {
    const args = [
      "-p",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--disable-slash-commands",
      ...(this.settings.model ? ["--model", this.settings.model] : []),
    ];
    const env = { ...process.env };
    for (const key of PAID_BILLING_ENV_VARS) delete env[key];
    const cwd = await mkdtemp(join(tmpdir(), "ai-note-claude-"));
    try {
      const { stdout } = await runProcess("claude", args, {
        stdin: prompt,
        timeoutMs: LLM_GENERATION_TIMEOUT_MS,
        cwd,
        env,
      });
      return stdout.trim();
    } finally {
      // Cleanup is deliberately best-effort: a generated result remains valid
      // even when antivirus/indexer timing prevents immediate temp removal.
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
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
