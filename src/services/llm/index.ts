import { readSettings } from "@/lib/settings";
import { ClaudeCliAdapter } from "@/services/llm/claudeCli";
import { CodexCliAdapter } from "@/services/llm/codexCli";
import { FakeAdapter } from "@/services/llm/fake";
import { OllamaAdapter } from "@/services/llm/ollama";
import type { LlmAdapter, LlmSettings } from "@/services/llm/types";

// Factory: maps LlmSettings → the concrete adapter. FAKE_LLM=1 short-circuits to
// the offline backend regardless of provider (tests / AC / build-green smokes).

export function getAdapter(settings: LlmSettings): LlmAdapter {
  if (process.env.FAKE_LLM === "1") return new FakeAdapter(settings);
  switch (settings.provider) {
    case "claude-cli":
      return new ClaudeCliAdapter(settings);
    case "codex-cli":
      return new CodexCliAdapter(settings);
    case "ollama":
      return new OllamaAdapter(settings);
  }
}

// Convenience: resolve the persisted settings and build its adapter. Returns null
// when no provider has been configured yet (data/settings.json missing/invalid).
export async function getConfiguredAdapter(): Promise<LlmAdapter | null> {
  const settings = await readSettings();
  return settings ? getAdapter(settings) : null;
}

export { LLM_PROVIDERS } from "@/services/llm/types";
export type {
  LlmAdapter,
  LlmHealth,
  LlmProvider,
  LlmSettings,
} from "@/services/llm/types";
