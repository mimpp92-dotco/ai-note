import { LLM_GENERATION_TIMEOUT_MS } from "@/services/llm/exec";
import type { LlmAdapter, LlmHealth, LlmProvider, LlmSettings } from "@/services/llm/types";

// Ollama backend — a local model daemon on 127.0.0.1. The daemon is frequently
// DOWN (not started), so both run() and health() must handle ECONNREFUSED
// gracefully rather than throwing an opaque fetch error.

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";

export class OllamaAdapter implements LlmAdapter {
  readonly provider: LlmProvider = "ollama";
  private readonly baseUrl: string;

  constructor(private readonly settings: LlmSettings) {
    this.baseUrl = settings.baseUrl || DEFAULT_BASE_URL;
  }

  async run(prompt: string, opts?: { json?: boolean }): Promise<string> {
    const model = this.settings.model;
    if (!model) throw new Error("Ollama model not set");

    // Bound the call so a stuck daemon can't wedge the worker (CLI adapters get
    // this from exec.ts; fetch needs an explicit AbortController).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_GENERATION_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          ...(opts?.json ? { format: "json" } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);

      const data = (await res.json()) as { response?: string };
      return data.response ?? "";
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<LlmHealth> {
    const model = this.settings.model;
    if (!model) return { ok: false, detail: "Ollama model not set" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: controller.signal });
      if (!res.ok) return { ok: false, detail: `Ollama responded ${res.status}` };

      const data = (await res.json()) as { models?: { name?: string }[] };
      const names = (data.models ?? []).map((m) => m.name).filter(Boolean);
      if (!names.includes(model)) {
        return { ok: false, detail: `model '${model}' not pulled — run: ollama pull ${model}` };
      }
      return { ok: true, detail: "Ollama ready" };
    } catch {
      return { ok: false, detail: "Ollama not running — start `ollama serve`" };
    } finally {
      clearTimeout(timer);
    }
  }
}
