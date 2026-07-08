// LLM summarizer backends. The app never stores an API key: each backend is
// either a CLI you're already signed into (Claude/Codex) or a local model
// (Ollama). Adapters produce raw text; src/lib/summarizeCore.ts parses/validates.

export type LlmProvider = "claude-cli" | "codex-cli" | "ollama";

export const LLM_PROVIDERS: readonly LlmProvider[] = [
  "claude-cli",
  "codex-cli",
  "ollama",
] as const;

export interface LlmSettings {
  provider: LlmProvider;
  /** Model id. Optional — each backend has a sensible default. */
  model?: string;
  /** Ollama base URL override (default http://127.0.0.1:11434). */
  baseUrl?: string;
}

export interface LlmHealth {
  ok: boolean;
  /** Human-readable status/reason, surfaced in the UI (e.g. "not logged in"). */
  detail: string;
}

export interface LlmAdapter {
  provider: LlmProvider;
  /**
   * Run one prompt, return the model's text output. `json: true` hints the
   * backend to emit JSON where supported (summarizeCore tolerates prose/fences
   * regardless, so this is best-effort).
   */
  run(prompt: string, opts?: { json?: boolean }): Promise<string>;
  /** Cheap reachability/auth check for the settings "test connection" button. */
  health(): Promise<LlmHealth>;
}
