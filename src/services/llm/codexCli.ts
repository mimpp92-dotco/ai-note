import { constants } from "node:fs";
import {
  chmod,
  mkdtemp,
  open,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
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

// Codex CLI backend — BEST-EFFORT. `codex exec` is an agentic runner (not a plain
// completion API): it emits a JSONL event stream on stdout, from which we salvage
// the model's final message. Auth is only verified on the first real summary, so
// health() just confirms the binary exists. Run read-only in a temp cwd, and skip
// the git-repo check so it works outside a repo.
//
// Codex's `--json` event stream remains the old-CLI fallback. Newer versions can
// additionally write the final message and validate generated summaries against
// a schema; both are enabled only after a bounded help capability probe.

const CODEX_OPTIONAL_FLAGS = [
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--output-schema",
  "--output-last-message",
  "--color",
] as const;
const LAST_MESSAGE_MAX_BYTES = 1024 * 1024;

export class CodexCliAdapter implements LlmAdapter {
  readonly provider: LlmProvider = "codex-cli";

  constructor(private readonly settings: LlmSettings) {}

  async run(prompt: string, opts?: LlmRunOptions): Promise<string> {
    const capabilities = await detectCliCapabilities({
      file: "codex",
      args: ["exec", "--help"],
      optionalFlags: CODEX_OPTIONAL_FLAGS,
    });
    const cwd = await mkdtemp(join(tmpdir(), "ai-note-codex-"));
    try {
      await chmod(cwd, 0o700);
      let schemaJson: string | null = null;
      if (opts?.jsonSchema !== undefined && capabilities.has("--output-schema")) {
        schemaJson = JSON.stringify(opts.jsonSchema) ?? null;
      }
      const schemaPath = schemaJson === null
        ? null
        : join(cwd, "generated-summary-schema.json");
      if (schemaPath && schemaJson) {
        await writeFile(schemaPath, `${schemaJson}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      }
      const lastMessagePath = capabilities.has("--output-last-message")
        ? join(cwd, "last-message.txt")
        : null;
      const args = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "-C",
        cwd,
        ...(capabilities.has("--ephemeral") ? ["--ephemeral"] : []),
        ...(capabilities.has("--ignore-user-config") ? ["--ignore-user-config"] : []),
        ...(capabilities.has("--ignore-rules") ? ["--ignore-rules"] : []),
        ...(schemaPath ? ["--output-schema", schemaPath] : []),
        ...(lastMessagePath ? ["--output-last-message", lastMessagePath] : []),
        ...(capabilities.has("--color") ? ["--color", "never"] : []),
        ...(this.settings.model ? ["-m", this.settings.model] : []),
        "-",
      ];
      const { stdout } = await runProcess("codex", args, {
        stdin: prompt,
        timeoutMs: LLM_GENERATION_TIMEOUT_MS,
        cwd,
      });
      if (lastMessagePath) {
        const lastMessage = await readBoundedLastMessage(lastMessagePath);
        if (lastMessage !== null) return lastMessage;
      }
      return extractFinalMessage(stdout);
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }

  async health(): Promise<LlmHealth> {
    try {
      await runProcess("codex", ["--version"], { timeoutMs: 15_000 });
      return {
        ok: true,
        detail: "Codex CLI가 감지되었습니다. 인증과 실제 요약 가능 여부는 첫 요약에서 확인합니다.",
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException | undefined;
      if (e?.code === "ENOENT" || (e?.message?.includes("ENOENT") ?? false)) {
        return {
          ok: false,
          detail: "Codex CLI를 찾을 수 없습니다. 설치 후 PATH를 확인하세요.",
        };
      }
      return {
        ok: false,
        detail: "Codex CLI 상태를 확인할 수 없습니다. 설치와 PATH를 확인하세요.",
      };
    }
  }
}

async function readBoundedLastMessage(path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > LAST_MESSAGE_MAX_BYTES) return null;

    const buffer = Buffer.alloc(LAST_MESSAGE_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > LAST_MESSAGE_MAX_BYTES) return null;
    try {
      const text = new TextDecoder("utf-8", { fatal: true })
        .decode(buffer.subarray(0, offset))
        .trim();
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
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
