import { LLM_GENERATION_TIMEOUT_MS } from "@/services/llm/exec";
import type {
  LlmAdapter,
  LlmHealth,
  LlmProvider,
  LlmRunOptions,
  LlmSettings,
} from "@/services/llm/types";
import { normalizeLoopbackHttpBaseUrl } from "@/lib/localEndpoint";

// Ollama backend — a local model daemon on 127.0.0.1. The daemon is frequently
// DOWN (not started), so both run() and health() must handle ECONNREFUSED
// gracefully rather than throwing an opaque fetch error.

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_DISCOVERY_TIMEOUT_MS = 3_000;
const OLLAMA_TAGS_MAX_BYTES = 256 * 1024;
const OLLAMA_MODEL_LIMIT = 100;
const OLLAMA_MODEL_NAME_LIMIT = 256;
const INVALID_MODEL_NAME = /[\u0000-\u001f\u007f]/u;

type OllamaFetch = (input: string, init: RequestInit) => Promise<Response>;

interface OllamaDiscoveryOptions {
  fetchImpl?: OllamaFetch;
  timeoutMs?: number;
}

class OllamaDiscoveryError extends Error {
  constructor(message = "ollama_discovery_failed") {
    super(message);
    this.name = "OllamaDiscoveryError";
  }
}

export function parseOllamaTags(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OllamaDiscoveryError("invalid_ollama_tags");
  }
  const models = (value as { models?: unknown }).models;
  if (!Array.isArray(models)) throw new OllamaDiscoveryError("invalid_ollama_tags");

  const names: string[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (names.length >= OLLAMA_MODEL_LIMIT) break;
    if (typeof model !== "object" || model === null || Array.isArray(model)) continue;
    const name = (model as { name?: unknown }).name;
    if (
      typeof name !== "string"
      || name.length === 0
      || name.length > OLLAMA_MODEL_NAME_LIMIT
      || name !== name.trim()
      || INVALID_MODEL_NAME.test(name)
      || seen.has(name)
    ) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > OLLAMA_TAGS_MAX_BYTES) {
      throw new OllamaDiscoveryError();
    }
  }
  if (!response.body) throw new OllamaDiscoveryError();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > OLLAMA_TAGS_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new OllamaDiscoveryError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new OllamaDiscoveryError("invalid_ollama_tags");
  }
}

export async function discoverOllamaModels(
  baseUrl = DEFAULT_BASE_URL,
  options: OllamaDiscoveryOptions = {},
): Promise<string[]> {
  const normalizedBaseUrl = normalizeLoopbackHttpBaseUrl(baseUrl || DEFAULT_BASE_URL);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? OLLAMA_DISCOVERY_TIMEOUT_MS,
  );
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${normalizedBaseUrl}/api/tags`, {
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok || response.redirected) throw new OllamaDiscoveryError();
    return parseOllamaTags(await readBoundedJson(response));
  } catch (error) {
    if (error instanceof OllamaDiscoveryError) throw error;
    throw new OllamaDiscoveryError();
  } finally {
    clearTimeout(timer);
  }
}

export class OllamaAdapter implements LlmAdapter {
  readonly provider: LlmProvider = "ollama";
  private readonly baseUrl: string;

  constructor(private readonly settings: LlmSettings) {
    this.baseUrl = normalizeLoopbackHttpBaseUrl(settings.baseUrl || DEFAULT_BASE_URL);
  }

  async run(prompt: string, opts?: LlmRunOptions): Promise<string> {
    const model = this.settings.model?.trim();
    if (!model) throw new Error("Ollama model not set");
    const format = opts?.jsonSchema ?? (opts?.json ? "json" : undefined);

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
          ...(format === undefined ? {} : { format }),
        }),
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      });
      if (!res.ok || res.redirected) {
        throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as { response?: string };
      return data.response ?? "";
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<LlmHealth> {
    const model = this.settings.model?.trim();
    if (!model) return { ok: false, detail: "Ollama 모델을 선택해 저장하세요." };

    try {
      const names = await discoverOllamaModels(this.baseUrl);
      if (!names.includes(model)) {
        return {
          ok: false,
          detail: "선택한 Ollama 모델이 설치되어 있지 않습니다. 모델을 준비한 뒤 다시 검사하세요.",
        };
      }
      return { ok: true, detail: "Ollama에 연결되었고 선택한 모델이 설치되어 있습니다." };
    } catch {
      return {
        ok: false,
        detail: "Ollama에 연결할 수 없습니다. ollama serve를 실행한 뒤 다시 검사하세요.",
      };
    }
  }
}
