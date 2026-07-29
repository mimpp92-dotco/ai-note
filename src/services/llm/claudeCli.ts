import { tmpdir } from "node:os";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { detectCliCapabilities } from "@/services/llm/cliCapabilities";
import { LLM_GENERATION_TIMEOUT_MS, runProcess } from "@/services/llm/exec";
import type {
  LlmAdapter,
  LlmHealth,
  LlmProvider,
  LlmRunOptions,
  LlmSettings,
} from "@/services/llm/types";

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

const CLAUDE_OPTIONAL_FLAGS = [
  "--safe-mode",
  "--no-session-persistence",
  "--tools",
  "--no-chrome",
  "--json-schema",
] as const;

export class ClaudeCliAdapter implements LlmAdapter {
  readonly provider: LlmProvider = "claude-cli";

  constructor(private readonly settings: LlmSettings) {}

  // JSON options use `claude -p --output-format json`; explicit summary schemas
  // additionally use help-proven `--json-schema`. We unwrap structured_output or
  // the result text so the caller's tolerant extractor remains the final safety
  // net. Plain correction calls keep text output.
  //
  // Isolated + self-contained (aligned with codexCli's `-C tmpdir()` pattern):
  // run in a temp cwd, never the project directory, so no workspace CLAUDE.md /
  // MCP context leaks into the correction (a past pollution bug). MCP + slash
  // commands are off for a minimal session with a clean teardown. Paid-billing
  // env vars are scrubbed (PAID_BILLING_ENV_VARS) so a subscription-OAuth CLI is
  // never silently metered to a paid API ($0 invariant); HOME/PATH stay so OAuth
  // keychain access and binary lookup still work. The transcript goes via stdin
  // only (never argv: `ps` exposure + ARG_MAX).
  async run(prompt: string, opts?: LlmRunOptions): Promise<string> {
    const capabilities = await detectCliCapabilities({
      file: "claude",
      args: ["--help"],
      optionalFlags: CLAUDE_OPTIONAL_FLAGS,
    });
    const wantsJson = opts?.json === true || opts?.jsonSchema !== undefined;
    let jsonSchemaArgument: string | null = null;
    if (opts?.jsonSchema !== undefined && capabilities.has("--json-schema")) {
      jsonSchemaArgument = JSON.stringify(opts.jsonSchema) ?? null;
    }
    const args = [
      "-p",
      ...(wantsJson ? ["--output-format", "json"] : []),
      ...(capabilities.has("--safe-mode") ? ["--safe-mode"] : []),
      ...(capabilities.has("--no-session-persistence")
        ? ["--no-session-persistence"]
        : []),
      ...(capabilities.has("--tools") ? ["--tools", ""] : []),
      ...(capabilities.has("--no-chrome") ? ["--no-chrome"] : []),
      ...(jsonSchemaArgument === null
        ? []
        : ["--json-schema", jsonSchemaArgument]),
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
      await chmod(cwd, 0o700);
      const { stdout } = await runProcess("claude", args, {
        stdin: prompt,
        timeoutMs: LLM_GENERATION_TIMEOUT_MS,
        cwd,
        env,
      });
      return wantsJson
        ? unwrapResultEnvelope(stdout, jsonSchemaArgument !== null)
        : stdout.trim();
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
      return {
        ok: true,
        detail: "Claude CLI가 감지되었습니다. 인증과 실제 요약 가능 여부는 첫 요약에서 확인합니다.",
      };
    } catch (err) {
      if (isEnoent(err)) {
        return {
          ok: false,
          detail: "Claude CLI를 찾을 수 없습니다. 설치 후 PATH를 확인하세요.",
        };
      }
      return {
        ok: false,
        detail: "Claude CLI 상태를 확인할 수 없습니다. 설치와 PATH를 확인하세요.",
      };
    }
  }
}

// Unwrap the schema-validated object or generic result text. Fall back to the
// untouched stdout when the envelope is absent or unparseable so the caller's
// tolerant extractor still gets a chance at whatever the CLI produced.
function unwrapResultEnvelope(
  stdout: string,
  preferStructuredOutput = false,
): string {
  const trimmed = stdout.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const envelope = parsed as Record<string, unknown>;
      const structuredOutput = envelope.structured_output;
      if (
        preferStructuredOutput
        && structuredOutput
        && typeof structuredOutput === "object"
        && !Array.isArray(structuredOutput)
      ) {
        const structuredJson = JSON.stringify(structuredOutput);
        if (structuredJson !== undefined) return structuredJson;
      }
      const result = envelope.result;
      if (typeof result === "string") return result.trim();
    }
  } catch {
    // not the JSON envelope — hand back raw stdout unchanged.
  }
  return trimmed;
}

function isEnoent(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException | undefined;
  return e?.code === "ENOENT" || (e?.message?.includes("ENOENT") ?? false);
}
