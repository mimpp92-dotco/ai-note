import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteFile } from "@/lib/atomicWrite";
import { normalizeLoopbackHttpBaseUrl } from "@/lib/localEndpoint";
import { LLM_PROVIDERS, type LlmSettings } from "@/services/llm/types";

// LLM settings live in data/settings.json — app-api is the single writer, the
// file is gitignored, and it holds NO secrets (provider choice + optional
// model/baseUrl only). Read lazily so `next build` never touches the filesystem.

export function settingsPath(): string {
  return join(process.cwd(), "data", "settings.json");
}

export async function readSettings(): Promise<LlmSettings | null> {
  try {
    const raw = await readFile(settingsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<LlmSettings>;
    if (!parsed || !parsed.provider || !LLM_PROVIDERS.includes(parsed.provider)) {
      return null;
    }
    return {
      provider: parsed.provider,
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.provider === "ollama" && parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // A corrupt settings.json shouldn't 500 the (polled) health endpoint — treat
    // it as unconfigured so the UI prompts the user to set a model again.
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

export async function writeSettings(settings: LlmSettings): Promise<void> {
  const model = settings.model?.trim();
  const normalized: LlmSettings = {
    provider: settings.provider,
    ...(model ? { model } : {}),
    ...(settings.provider === "ollama" && settings.baseUrl
      ? { baseUrl: normalizeLoopbackHttpBaseUrl(settings.baseUrl) }
      : {}),
  };
  await atomicWriteFile(settingsPath(), JSON.stringify(normalized, null, 2) + "\n");
}
