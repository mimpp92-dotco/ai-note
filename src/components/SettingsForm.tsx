"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import {
  formatLlmStatus,
  type LlmHealthState,
  providerLabel,
} from "@/components/healthStatus";
import { GuardedLink } from "@/components/RecorderNavigation";
import { LLM_PROVIDERS, type LlmProvider } from "@/services/llm/types";

// The app-api owns data/settings.json. This form keeps a server-confirmed snapshot
// separate from provider-specific editable drafts. Health always checks the
// persisted snapshot; Ollama discovery is a separate read-only draft operation.

const PROVIDERS: { value: LlmProvider; label: string; hint: string }[] = [
  { value: "claude-cli", label: "Claude CLI", hint: "구독 CLI 사용 · 권장" },
  { value: "codex-cli", label: "Codex CLI", hint: "구독 CLI 사용 · 직접 입력 지원" },
  { value: "ollama", label: "Ollama", hint: "로컬에 설치된 모델 사용" },
];

const CUSTOM_MODEL = "__custom__";
const CLAUDE_MODELS = new Set(["sonnet", "opus", "haiku"]);
const MODEL_LIMIT = 100;
const MODEL_NAME_LIMIT = 256;
const INVALID_MODEL_NAME = /[\u0000-\u001f\u007f]/u;

const field =
  "min-h-11 w-full min-w-0 rounded-md border border-inkFaint bg-panel px-3 py-2 text-[14px] text-ink placeholder:text-inkSoft focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

type LoadState = "loading" | "ready" | "load_error";
type FieldError = "model" | "baseUrl" | null;
type DiscoveryState = "idle" | "loading" | "ready" | "error";

interface SettingsSnapshot {
  provider: LlmProvider;
  model: string;
  baseUrl: string;
}

interface ProviderDraft {
  selection: string;
  customModel: string;
  baseUrl: string;
}

type ProviderDrafts = Record<LlmProvider, ProviderDraft>;

type ParsedSettings =
  | { ok: true; value: SettingsSnapshot | null }
  | { ok: false };

function parseSettings(value: unknown): ParsedSettings {
  if (typeof value !== "object" || value === null) return { ok: false };
  const candidate = value as { provider?: unknown; model?: unknown; baseUrl?: unknown };
  if (candidate.provider === null) return { ok: true, value: null };
  if (
    typeof candidate.provider !== "string"
    || !LLM_PROVIDERS.includes(candidate.provider as LlmProvider)
  ) {
    return { ok: false };
  }
  if (candidate.model !== undefined && typeof candidate.model !== "string") return { ok: false };
  if (candidate.baseUrl !== undefined && typeof candidate.baseUrl !== "string") return { ok: false };
  const provider = candidate.provider as LlmProvider;
  return {
    ok: true,
    value: {
      provider,
      model: candidate.model?.trim() ?? "",
      baseUrl: provider === "ollama" ? candidate.baseUrl?.trim() ?? "" : "",
    },
  };
}

function parseModelResponse(value: unknown): string[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as { models?: unknown };
  if (
    Object.keys(candidate).some((key) => key !== "models")
    || !Array.isArray(candidate.models)
    || candidate.models.length > MODEL_LIMIT
  ) {
    return null;
  }
  const models: string[] = [];
  const seen = new Set<string>();
  for (const model of candidate.models) {
    if (
      typeof model !== "string"
      || model.length === 0
      || model.length > MODEL_NAME_LIMIT
      || model !== model.trim()
      || INVALID_MODEL_NAME.test(model)
      || seen.has(model)
    ) {
      return null;
    }
    seen.add(model);
    models.push(model);
  }
  return models;
}

function modelSelection(
  provider: LlmProvider,
  model: string,
  ollamaModels: string[] = [],
): string {
  if (provider === "claude-cli") {
    if (!model) return "";
    return CLAUDE_MODELS.has(model) ? model : CUSTOM_MODEL;
  }
  if (provider === "codex-cli") return model ? CUSTOM_MODEL : "";
  return model && ollamaModels.includes(model) ? model : CUSTOM_MODEL;
}

function providerDraft(
  provider: LlmProvider,
  model = "",
  baseUrl = "",
  ollamaModels: string[] = [],
): ProviderDraft {
  return {
    selection: modelSelection(provider, model, ollamaModels),
    customModel: model,
    baseUrl: provider === "ollama" ? baseUrl : "",
  };
}

function providerDrafts(snapshot: SettingsSnapshot | null): ProviderDrafts {
  const drafts: ProviderDrafts = {
    "claude-cli": providerDraft("claude-cli"),
    "codex-cli": providerDraft("codex-cli"),
    ollama: providerDraft("ollama"),
  };
  if (snapshot) {
    drafts[snapshot.provider] = providerDraft(
      snapshot.provider,
      snapshot.model,
      snapshot.baseUrl,
    );
  }
  return drafts;
}

function sameSettings(a: SettingsSnapshot | null, b: SettingsSnapshot): boolean {
  return a !== null
    && a.provider === b.provider
    && a.model === b.model
    && a.baseUrl === b.baseUrl;
}

function isHealthState(value: unknown): value is LlmHealthState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    configured?: unknown;
    provider?: unknown;
    ok?: unknown;
    detail?: unknown;
    model?: unknown;
  };
  if (candidate.configured === false) return true;
  return candidate.configured === true
    && typeof candidate.provider === "string"
    && LLM_PROVIDERS.includes(candidate.provider as LlmProvider)
    && typeof candidate.ok === "boolean"
    && typeof candidate.detail === "string"
    && (
      candidate.model === undefined
      || candidate.model === null
      || typeof candidate.model === "string"
    );
}

function healthMatchesSnapshot(
  health: LlmHealthState,
  snapshot: SettingsSnapshot,
): boolean {
  if (!health.configured) return true;
  return health.provider === snapshot.provider
    && (health.model?.trim() ?? "") === snapshot.model;
}

function snapshotLabel(snapshot: SettingsSnapshot): string {
  return `${providerLabel(snapshot.provider)}${snapshot.model ? ` · ${snapshot.model}` : ""}`;
}

function failedHealth(snapshot: SettingsSnapshot): LlmHealthState {
  const provider = providerLabel(snapshot.provider);
  return {
    configured: true,
    provider: snapshot.provider,
    ...(snapshot.model ? { model: snapshot.model } : {}),
    ok: false,
    detail: snapshot.provider === "ollama"
      ? "연결 테스트 요청에 실패했습니다. Ollama 설정과 실행 상태를 확인한 뒤 다시 검사하세요."
      : `연결 테스트 요청에 실패했습니다. ${provider} 설치와 PATH를 확인한 뒤 다시 검사하세요.`,
  };
}

export function SettingsForm({ embedded = false }: { embedded?: boolean } = {}) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [savedSnapshot, setSavedSnapshot] = useState<SettingsSnapshot | null>(null);
  const [provider, setProvider] = useState<LlmProvider>("claude-cli");
  const [drafts, setDrafts] = useState<ProviderDrafts>(() => providerDrafts(null));
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [discoveryState, setDiscoveryState] = useState<DiscoveryState>("idle");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testedSnapshot, setTestedSnapshot] = useState<SettingsSnapshot | null>(null);
  const [health, setHealth] = useState<LlmHealthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<FieldError>(null);
  const [modelTouched, setModelTouched] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const loadAbortRef = useRef<AbortController | null>(null);
  const discoveryRequestRef = useRef(0);
  const healthRequestRef = useRef(0);

  const discoverOllama = useCallback(async (baseUrl: string) => {
    const requestId = ++discoveryRequestRef.current;
    setDiscoveryState("loading");
    try {
      const normalizedBaseUrl = baseUrl.trim();
      const response = await fetch("/api/settings/llm/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(normalizedBaseUrl ? { baseUrl: normalizedBaseUrl } : {}),
      });
      if (!response.ok) throw new Error("discovery failed");
      const models = parseModelResponse(await response.json());
      if (!models) throw new Error("invalid discovery response");
      if (requestId !== discoveryRequestRef.current) return;
      setOllamaModels(models);
      setDrafts((current) => {
        const draft = current.ollama;
        const normalizedModel = draft.customModel.trim();
        if (draft.selection !== CUSTOM_MODEL || !models.includes(normalizedModel)) {
          return current;
        }
        return {
          ...current,
          ollama: { ...draft, selection: normalizedModel },
        };
      });
      setDiscoveryState("ready");
    } catch {
      if (requestId === discoveryRequestRef.current) setDiscoveryState("error");
    }
  }, []);

  const applyLoadedSnapshot = useCallback((snapshot: SettingsSnapshot | null) => {
    setSavedSnapshot(snapshot);
    setProvider(snapshot?.provider ?? "claude-cli");
    setDrafts(providerDrafts(snapshot));
    setOllamaModels([]);
    setDiscoveryState("idle");
    setSaved(false);
    setHealth(null);
    setTestedSnapshot(null);
    setTesting(false);
    setError(null);
    setFieldError(null);
    setModelTouched(false);
    setSubmitAttempted(false);
    healthRequestRef.current += 1;
    if (snapshot?.provider === "ollama") {
      void discoverOllama(snapshot.baseUrl);
    }
  }, [discoverOllama]);

  const load = useCallback(async () => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoadState("loading");
    setError(null);
    try {
      const response = await fetch("/api/settings/llm", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("load failed");
      const parsed = parseSettings(await response.json());
      if (controller.signal.aborted) return;
      if (!parsed.ok) throw new Error("invalid response");
      applyLoadedSnapshot(parsed.value);
      setLoadState("ready");
    } catch {
      if (controller.signal.aborted) return;
      setLoadState("load_error");
    }
  }, [applyLoadedSnapshot]);

  useEffect(() => {
    void load();
    return () => {
      loadAbortRef.current?.abort();
      discoveryRequestRef.current += 1;
      healthRequestRef.current += 1;
    };
  }, [load]);

  const currentDraft = drafts[provider];
  const isOllama = provider === "ollama";
  const customSelected = currentDraft.selection === CUSTOM_MODEL;
  const normalizedModel = (
    customSelected ? currentDraft.customModel : currentDraft.selection
  ).trim();
  const draft: SettingsSnapshot = {
    provider,
    model: normalizedModel,
    baseUrl: isOllama ? currentDraft.baseUrl.trim() : "",
  };
  const ready = loadState === "ready";
  const dirty = ready && !sameSettings(savedSnapshot, draft);
  const modelMissing = isOllama && draft.model.length === 0;
  const showModelError = modelMissing
    && (modelTouched || submitAttempted || fieldError === "model");
  const showBaseUrlError = isOllama && fieldError === "baseUrl";
  const valid = !modelMissing && !showBaseUrlError;
  const canSave = ready && dirty && valid && !saving;
  const canTest = ready
    && savedSnapshot !== null
    && !dirty
    && !saving
    && !testing;

  const clearDraftFeedback = () => {
    healthRequestRef.current += 1;
    setSaved(false);
    setTesting(false);
    setHealth(null);
    setTestedSnapshot(null);
    setError(null);
  };

  const updateCurrentDraft = (patch: Partial<ProviderDraft>) => {
    setDrafts((current) => ({
      ...current,
      [provider]: { ...current[provider], ...patch },
    }));
  };

  const checkPersistedHealth = async (snapshot: SettingsSnapshot) => {
    const requestId = ++healthRequestRef.current;
    setTesting(true);
    setHealth(null);
    setTestedSnapshot(null);
    try {
      const response = await fetch("/api/settings/llm/health", { cache: "no-store" });
      if (!response.ok) throw new Error("health failed");
      const data: unknown = await response.json();
      if (!isHealthState(data) || !healthMatchesSnapshot(data, snapshot)) {
        throw new Error("invalid health");
      }
      if (requestId !== healthRequestRef.current) return;
      setHealth(data);
      setTestedSnapshot(snapshot);
    } catch {
      if (requestId !== healthRequestRef.current) return;
      setHealth(failedHealth(snapshot));
      setTestedSnapshot(snapshot);
    } finally {
      if (requestId === healthRequestRef.current) setTesting(false);
    }
  };

  const applySavedSnapshot = (snapshot: SettingsSnapshot) => {
    setSavedSnapshot(snapshot);
    setProvider(snapshot.provider);
    setDrafts((current) => ({
      ...current,
      [snapshot.provider]: providerDraft(
        snapshot.provider,
        snapshot.model,
        snapshot.baseUrl,
        ollamaModels,
      ),
    }));
    setError(null);
    setFieldError(null);
    setModelTouched(false);
    setSubmitAttempted(false);
    setSaved(true);
    setLoadState("ready");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitAttempted(true);
    if (!ready || !dirty || saving || modelMissing || showBaseUrlError) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    setFieldError(null);
    try {
      const body: { provider: LlmProvider; model?: string; baseUrl?: string } = {
        provider: draft.provider,
      };
      if (draft.model) body.model = draft.model;
      if (isOllama && draft.baseUrl) body.baseUrl = draft.baseUrl;
      const response = await fetch("/api/settings/llm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        let hintedField: unknown;
        try {
          const payload = await response.json() as {
            error?: { details?: { field?: unknown } };
          };
          hintedField = payload.error?.details?.field;
        } catch {
          // Static safe copy below; raw server output is never shown.
        }
        if (hintedField === "model" || hintedField === "baseUrl") {
          setFieldError(hintedField);
        }
        setError("설정을 저장하지 못했어요. 입력값을 확인하세요.");
        return;
      }
      const parsed = parseSettings(await response.json());
      if (!parsed.ok || parsed.value === null) {
        setError("설정을 저장하지 못했어요. 잠시 후 다시 시도하세요.");
        return;
      }
      applySavedSnapshot(parsed.value);
      setSaving(false);
      void checkPersistedHealth(parsed.value);
    } catch {
      setError("설정을 저장하지 못했어요. 잠시 후 다시 시도하세요.");
    } finally {
      setSaving(false);
    }
  };

  const test = () => {
    const snapshot = savedSnapshot;
    if (!canTest || snapshot === null) return;
    void checkPersistedHealth(snapshot);
  };

  const testReason = !ready
    ? "설정을 불러온 뒤 연결을 테스트할 수 있습니다."
    : savedSnapshot === null
      ? "먼저 설정을 저장한 뒤 연결을 테스트하세요."
      : saving
        ? "설정 저장이 끝난 뒤 연결을 테스트할 수 있습니다."
        : testing
          ? "저장된 설정의 상태를 확인하고 있습니다."
          : dirty
            ? "변경 사항을 먼저 저장하세요. 연결 테스트는 저장된 설정만 검사합니다."
            : "연결 테스트는 현재 저장된 설정을 검사합니다.";

  const Root: "main" | "section" = embedded ? "section" : "main";

  return (
    <Root
      id={embedded ? undefined : "main"}
      aria-labelledby={embedded ? "llm-settings-heading" : undefined}
      className={embedded
        ? "min-w-0 space-y-6"
        : "max-w-2xl space-y-8 px-4 py-12 sm:px-6"}
    >
      <div>
        {embedded ? (
          <h2 id="llm-settings-heading" className="text-[19px] font-bold tracking-tight text-ink">
            요약 모델
          </h2>
        ) : (
          <h1 className="text-2xl font-bold tracking-tight text-ink">요약 모델 설정</h1>
        )}
        <p className="mt-2 text-[15px] leading-relaxed text-inkSoft">
          회의록 요약에 사용할 모델을 선택합니다. 녹음·전사는 모델 없이도 동작하며, 요약만 모델이 필요합니다.
        </p>
      </div>

      {loadState === "loading" && (
        <div className="rounded-[16px] border border-line bg-panel p-4 sm:p-6">
          <p role="status" className="text-[14px] text-inkSoft">설정을 불러오는 중…</p>
        </div>
      )}

      {loadState === "load_error" && (
        <div className="space-y-3 rounded-[16px] border border-line bg-panel p-4 sm:p-6">
          <p role="status" className="text-[14px] text-error">
            설정을 불러오지 못했어요. 저장하면 기존 설정을 덮어쓸 수 있어 편집을 잠갔습니다.
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="min-h-11 rounded-lg border border-line bg-panel px-4 text-[13px] font-medium text-accent transition-colors hover:bg-soft"
          >
            다시 시도
          </button>
        </div>
      )}

      {ready && (
        <form
          onSubmit={(event) => void submit(event)}
          className="space-y-6 rounded-[16px] border border-line bg-panel p-4 shadow-[0_1px_2px_rgba(42,36,32,.04)] sm:p-6"
        >
          {savedSnapshot === null && (
            <p className="rounded-md bg-warnBg px-3 py-2 text-[13px] text-ink">
              저장된 요약 모델 설정이 없습니다.
            </p>
          )}

          <fieldset className="space-y-3">
            <legend className="text-[14px] font-bold text-ink">모델 백엔드</legend>
            <div className="space-y-2">
              {PROVIDERS.map((item) => (
                <label
                  key={item.value}
                  className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-[12px] border px-4 py-3 transition-colors ${
                    provider === item.value
                      ? "border-accent bg-soft"
                      : "border-line bg-panel hover:bg-chrome"
                  }`}
                >
                  <input
                    type="radio"
                    name="provider"
                    value={item.value}
                    checked={provider === item.value}
                    onChange={() => {
                      setProvider(item.value);
                      setModelTouched(false);
                      setSubmitAttempted(false);
                      setFieldError(null);
                      clearDraftFeedback();
                      if (item.value === "ollama") {
                        void discoverOllama(drafts.ollama.baseUrl);
                      }
                    }}
                    className="mt-0.5 accent-accent"
                  />
                  <span>
                    <span className="block text-[14px] font-semibold text-ink">{item.label}</span>
                    <span className="mt-0.5 block text-[13px] text-inkSoft">{item.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="min-w-0">
            <label htmlFor="settings-model" className="text-[13px] font-medium text-inkSoft">
              모델 {isOllama ? "(필수)" : "(선택)"}
            </label>
            <div className="mt-1 flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center">
              <select
                id="settings-model"
                aria-label="모델"
                value={currentDraft.selection}
                onChange={(event) => {
                  updateCurrentDraft({ selection: event.target.value });
                  if (fieldError === "model") setFieldError(null);
                  setModelTouched(false);
                  clearDraftFeedback();
                }}
                className={field}
              >
                {provider === "claude-cli" && (
                  <>
                    <option value="">CLI 기본값 (권장)</option>
                    <option value="sonnet">Sonnet</option>
                    <option value="opus">Opus</option>
                    <option value="haiku">Haiku</option>
                    <option value={CUSTOM_MODEL}>직접 입력</option>
                  </>
                )}
                {provider === "codex-cli" && (
                  <>
                    <option value="">CLI 기본값 (권장)</option>
                    <option value={CUSTOM_MODEL}>직접 입력</option>
                  </>
                )}
                {provider === "ollama" && (
                  <>
                    {ollamaModels.map((model) => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                    <option value={CUSTOM_MODEL}>직접 입력</option>
                  </>
                )}
              </select>
              {isOllama && (
                <button
                  type="button"
                  disabled={discoveryState === "loading"}
                  onClick={() => void discoverOllama(currentDraft.baseUrl)}
                  className="min-h-11 w-full shrink-0 rounded-lg border border-line bg-panel px-4 text-[13px] font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50 sm:w-auto"
                >
                  {discoveryState === "loading" ? "모델 불러오는 중…" : "설치된 모델 새로고침"}
                </button>
              )}
            </div>
            {isOllama && discoveryState === "ready" && ollamaModels.length === 0 && (
              <p className="mt-1 text-[12px] leading-relaxed text-inkSoft">
                설치된 모델을 찾지 못했습니다. 자동 다운로드하지 않으므로 모델을 준비하거나 직접 입력하세요.
              </p>
            )}
            {isOllama && discoveryState === "error" && (
              <p role="status" className="mt-1 text-[12px] leading-relaxed text-error">
                설치된 모델을 불러오지 못했어요. Ollama와 Base URL을 확인한 뒤 다시 시도하세요. 입력값은 유지했습니다.
              </p>
            )}
          </div>

          {customSelected && (
            <div className="min-w-0">
              <label
                htmlFor="settings-custom-model"
                className="text-[13px] font-medium text-inkSoft"
              >
                직접 입력 모델
              </label>
              <input
                id="settings-custom-model"
                className={`mt-1 ${field}`}
                value={currentDraft.customModel}
                onChange={(event) => {
                  updateCurrentDraft({ customModel: event.target.value });
                  if (fieldError === "model") setFieldError(null);
                  clearDraftFeedback();
                }}
                onBlur={() => setModelTouched(true)}
                aria-invalid={showModelError ? "true" : undefined}
                aria-describedby={showModelError
                  ? "settings-model-error"
                  : modelMissing
                    ? "settings-model-help"
                    : undefined}
                placeholder={isOllama
                  ? "예: llama3.2:latest"
                  : "모델 식별자를 그대로 입력하세요"}
              />
              {modelMissing && !showModelError && (
                <span id="settings-model-help" className="mt-1 block text-[12px] text-inkSoft">
                  모델명이 필요합니다.
                </span>
              )}
              {showModelError && (
                <span id="settings-model-error" className="mt-1 block text-[12px] text-error">
                  Ollama 모델명을 입력하세요.
                </span>
              )}
            </div>
          )}

          {isOllama && (
            <label htmlFor="settings-base-url" className="block min-w-0">
              <span className="text-[13px] font-medium text-inkSoft">Base URL (선택)</span>
              <input
                id="settings-base-url"
                className={`mt-1 ${field}`}
                value={currentDraft.baseUrl}
                onChange={(event) => {
                  discoveryRequestRef.current += 1;
                  setOllamaModels([]);
                  setDiscoveryState("idle");
                  updateCurrentDraft({ baseUrl: event.target.value });
                  if (fieldError === "baseUrl") setFieldError(null);
                  clearDraftFeedback();
                }}
                aria-invalid={showBaseUrlError ? "true" : undefined}
                aria-describedby={showBaseUrlError ? "settings-base-url-error" : undefined}
                placeholder="http://127.0.0.1:11434"
              />
              {showBaseUrlError && (
                <span id="settings-base-url-error" className="mt-1 block text-[12px] text-error">
                  explicit port가 있는 localhost 또는 127.0.0.1 URL을 확인하세요.
                </span>
              )}
            </label>
          )}

          <div className="flex min-w-0 flex-col flex-wrap items-stretch gap-3 sm:flex-row sm:items-center">
            <button
              type="submit"
              disabled={!canSave}
              className="min-h-11 w-full rounded-full bg-ink px-5 text-[14px] font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-50 sm:w-auto"
            >
              {saving ? "저장 중…" : "저장"}
            </button>
            <button
              type="button"
              onClick={test}
              disabled={!canTest}
              aria-describedby="settings-test-reason"
              className="min-h-11 w-full rounded-full border border-line bg-panel px-5 text-[14px] font-semibold text-accent transition-colors hover:bg-soft disabled:opacity-50 sm:w-auto"
            >
              {testing ? "검사 중…" : "연결 테스트"}
            </button>
            {saved && <span className="text-[13px] text-success">저장됨</span>}
            {error && (
              <span role="status" aria-live="polite" className="min-w-0 text-[13px] text-error">
                {error}
              </span>
            )}
          </div>

          <p id="settings-test-reason" className="text-[12px] leading-relaxed text-inkSoft">
            {testReason}
          </p>

          {health && <HealthMessage health={health} />}
          {health && testedSnapshot && (
            <p className="text-[12px] text-inkSoft">
              검사한 저장 설정: {snapshotLabel(testedSnapshot)}
            </p>
          )}
          {health?.configured && health.ok && (
            <GuardedLink
              href="/#recorder"
              className="inline-flex min-h-11 w-full items-center justify-center rounded-full border border-line px-4 text-[13px] font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:w-auto"
            >
              첫 회의 녹음
            </GuardedLink>
          )}

          <p className="border-t border-line pt-4 text-[13px] leading-relaxed text-inkSoft">
            API 키는 저장되지 않습니다. 구독 CLI 또는 로컬 Ollama만 사용하며, CLI 인증과 실제 요약 가능 여부는 첫 요약에서 확인합니다.
          </p>
        </form>
      )}
    </Root>
  );
}

function HealthMessage({ health }: { health: LlmHealthState }) {
  const status = formatLlmStatus(health);
  const bg =
    status.tone === "success"
      ? "bg-successBg text-success"
      : status.tone === "warn"
        ? "bg-warnBg text-ink"
        : "bg-error/10 text-error";
  return (
    <p role="status" className={`rounded-md px-3 py-2 text-[13px] ${bg}`} title={status.title}>
      {health.configured
        ? `${status.label} — ${health.detail}`
        : "저장한 요약 모델 설정을 확인할 수 없습니다. 다시 저장한 뒤 검사하세요."}
    </p>
  );
}
