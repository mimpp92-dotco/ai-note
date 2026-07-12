"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import {
  formatLlmStatus,
  type LlmHealthState,
  providerLabel,
} from "@/components/healthStatus";
import { LLM_PROVIDERS, type LlmProvider } from "@/services/llm/types";

// The app-api owns data/settings.json. This form keeps a server-confirmed snapshot
// separate from the editable draft so load failures and unsaved values can never be
// mistaken for persisted configuration.

const PROVIDERS: { value: LlmProvider; label: string; hint: string }[] = [
  { value: "claude-cli", label: "Claude CLI", hint: "구독 CLI 사용 · 권장" },
  { value: "codex-cli", label: "Codex CLI", hint: "구독 CLI 사용 · 지원은 best-effort" },
  { value: "ollama", label: "Ollama", hint: "로컬 모델 · 모델명이 필요합니다" },
];

const field =
  "min-h-11 w-full rounded-md border border-inkFaint bg-panel px-3 py-2 text-[14px] text-ink placeholder:text-inkSoft focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

type LoadState = "loading" | "ready" | "load_error";
type FieldError = "model" | "baseUrl" | null;

interface SettingsSnapshot {
  provider: LlmProvider;
  model: string;
  baseUrl: string;
}

type ParsedSettings =
  | { ok: true; value: SettingsSnapshot | null }
  | { ok: false };

function parseSettings(value: unknown): ParsedSettings {
  if (typeof value !== "object" || value === null) return { ok: false };
  const candidate = value as { provider?: unknown; model?: unknown; baseUrl?: unknown };
  if (candidate.provider === null) return { ok: true, value: null };
  if (typeof candidate.provider !== "string" || !LLM_PROVIDERS.includes(candidate.provider as LlmProvider)) {
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

function sameSettings(a: SettingsSnapshot | null, b: SettingsSnapshot): boolean {
  return a !== null && a.provider === b.provider && a.model === b.model && a.baseUrl === b.baseUrl;
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
    && (candidate.model === undefined || candidate.model === null || typeof candidate.model === "string");
}

function snapshotLabel(snapshot: SettingsSnapshot): string {
  return `${providerLabel(snapshot.provider)}${snapshot.model ? ` · ${snapshot.model}` : ""}`;
}

export function SettingsForm({ embedded = false }: { embedded?: boolean } = {}) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [savedSnapshot, setSavedSnapshot] = useState<SettingsSnapshot | null>(null);
  const [provider, setProvider] = useState<LlmProvider>("claude-cli");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
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

  const applySnapshot = (snapshot: SettingsSnapshot | null) => {
    setSavedSnapshot(snapshot);
    setProvider(snapshot?.provider ?? "claude-cli");
    setModel(snapshot?.model ?? "");
    setBaseUrl(snapshot?.baseUrl ?? "");
    setSaved(false);
    setHealth(null);
    setTestedSnapshot(null);
    setError(null);
    setFieldError(null);
    setModelTouched(false);
    setSubmitAttempted(false);
  };

  const load = useCallback(async () => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoadState("loading");
    setError(null);
    try {
      const response = await fetch("/api/settings/llm", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("load failed");
      const parsed = parseSettings(await response.json());
      if (controller.signal.aborted) return;
      if (!parsed.ok) throw new Error("invalid response");
      applySnapshot(parsed.value);
      setLoadState("ready");
    } catch {
      if (controller.signal.aborted) return;
      setLoadState("load_error");
    }
  }, []);

  useEffect(() => {
    void load();
    return () => loadAbortRef.current?.abort();
  }, [load]);

  const isOllama = provider === "ollama";
  const draft: SettingsSnapshot = {
    provider,
    model: model.trim(),
    baseUrl: isOllama ? baseUrl.trim() : "",
  };
  const ready = loadState === "ready";
  const dirty = ready && !sameSettings(savedSnapshot, draft);
  const modelMissing = isOllama && draft.model.length === 0;
  const showModelError = modelMissing && (modelTouched || submitAttempted || fieldError === "model");
  const showBaseUrlError = isOllama && fieldError === "baseUrl";
  const valid = !modelMissing && !showBaseUrlError;
  const canSave = ready && dirty && valid && !saving;
  const canTest = ready && savedSnapshot !== null && !dirty && !saving && !testing;

  const clearDraftFeedback = () => {
    setSaved(false);
    setHealth(null);
    setTestedSnapshot(null);
    setError(null);
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
      const body: { provider: LlmProvider; model?: string; baseUrl?: string } = { provider: draft.provider };
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
          const payload = await response.json() as { error?: { details?: { field?: unknown } } };
          hintedField = payload.error?.details?.field;
        } catch {
          // Static safe copy below; raw server output is never shown.
        }
        if (hintedField === "model" || hintedField === "baseUrl") setFieldError(hintedField);
        setError("설정을 저장하지 못했어요. 입력값을 확인하세요.");
        return;
      }
      const parsed = parseSettings(await response.json());
      if (!parsed.ok || parsed.value === null) {
        setError("설정을 저장하지 못했어요. 잠시 후 다시 시도하세요.");
        return;
      }
      applySnapshot(parsed.value);
      setSaved(true);
      setLoadState("ready");
    } catch {
      setError("설정을 저장하지 못했어요. 잠시 후 다시 시도하세요.");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    const snapshot = savedSnapshot;
    if (!canTest || snapshot === null) return;
    setTesting(true);
    setHealth(null);
    setTestedSnapshot(null);
    try {
      const response = await fetch("/api/settings/llm/health", { cache: "no-store" });
      if (!response.ok) throw new Error("health failed");
      const data: unknown = await response.json();
      if (!isHealthState(data)) throw new Error("invalid health");
      setHealth(data);
      setTestedSnapshot(snapshot);
    } catch {
      setHealth({
        configured: true,
        provider: snapshot.provider,
        ...(snapshot.model ? { model: snapshot.model } : {}),
        ok: false,
        detail: "연결 테스트 요청에 실패했습니다.",
      });
      setTestedSnapshot(snapshot);
    } finally {
      setTesting(false);
    }
  };

  const testReason = !ready
    ? "설정을 불러온 뒤 연결을 테스트할 수 있습니다."
    : savedSnapshot === null
      ? "먼저 설정을 저장한 뒤 연결을 테스트하세요."
      : saving
        ? "설정 저장이 끝난 뒤 연결을 테스트할 수 있습니다."
        : testing
          ? "저장된 설정의 연결을 확인하고 있습니다."
          : dirty
            ? "변경 사항을 먼저 저장하세요. 연결 테스트는 저장된 설정만 검사합니다."
            : "연결 테스트는 현재 저장된 설정을 검사합니다.";

  const Root: "main" | "section" = embedded ? "section" : "main";

  return (
    <Root
      id={embedded ? undefined : "main"}
      aria-labelledby={embedded ? "llm-settings-heading" : undefined}
      className={embedded ? "min-w-0 space-y-6" : "max-w-2xl space-y-8 px-4 py-12 sm:px-6"}
    >
      <div>
        {embedded ? (
          <h2 id="llm-settings-heading" className="text-[19px] font-bold tracking-tight text-ink">요약 모델</h2>
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
                    provider === item.value ? "border-accent bg-soft" : "border-line bg-panel hover:bg-chrome"
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

          <label htmlFor="settings-model" className="block">
            <span className="text-[13px] font-medium text-inkSoft">모델 {isOllama ? "(필수)" : "(선택)"}</span>
            <input
              id="settings-model"
              className={`mt-1 ${field}`}
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
                if (fieldError === "model") setFieldError(null);
                clearDraftFeedback();
              }}
              onBlur={() => setModelTouched(true)}
              aria-invalid={showModelError ? "true" : undefined}
              aria-describedby={showModelError ? "settings-model-error" : modelMissing ? "settings-model-help" : undefined}
              placeholder={isOllama ? "예: llama3.1" : "비워두면 기본 모델을 사용합니다"}
            />
            {modelMissing && !showModelError && (
              <span id="settings-model-help" className="mt-1 block text-[12px] text-inkSoft">모델명이 필요합니다.</span>
            )}
            {showModelError && (
              <span id="settings-model-error" className="mt-1 block text-[12px] text-error">
                Ollama 모델명을 입력하세요.
              </span>
            )}
          </label>

          {isOllama && (
            <label htmlFor="settings-base-url" className="block">
              <span className="text-[13px] font-medium text-inkSoft">Base URL (선택)</span>
              <input
                id="settings-base-url"
                className={`mt-1 ${field}`}
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  if (fieldError === "baseUrl") setFieldError(null);
                  clearDraftFeedback();
                }}
                aria-invalid={showBaseUrlError ? "true" : undefined}
                aria-describedby={showBaseUrlError ? "settings-base-url-error" : undefined}
                placeholder="http://127.0.0.1:11434"
              />
              {showBaseUrlError && (
                <span id="settings-base-url-error" className="mt-1 block text-[12px] text-error">
                  로컬 Base URL을 확인하세요.
                </span>
              )}
            </label>
          )}

          <div className="flex flex-wrap flex-col items-stretch gap-3 sm:flex-row sm:items-center">
            <button
              type="submit"
              disabled={!canSave}
              className="min-h-11 w-full rounded-full bg-ink px-5 text-[14px] font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-50 sm:w-auto"
            >
              {saving ? "저장 중…" : "저장"}
            </button>
            <button
              type="button"
              onClick={() => void test()}
              disabled={!canTest}
              aria-describedby="settings-test-reason"
              className="min-h-11 w-full rounded-full border border-line bg-panel px-5 text-[14px] font-semibold text-accent transition-colors hover:bg-soft disabled:opacity-50 sm:w-auto"
            >
              {testing ? "테스트 중…" : "연결 테스트"}
            </button>
            {saved && <span className="text-[13px] text-success">저장됨</span>}
            {error && (
              <span role="status" aria-live="polite" className="min-w-0 text-[13px] text-error">
                {error}
              </span>
            )}
          </div>

          <p id="settings-test-reason" className="text-[12px] leading-relaxed text-inkSoft">{testReason}</p>

          {health && <HealthMessage health={health} />}
          {health && testedSnapshot && (
            <p className="text-[12px] text-inkSoft">검사한 저장 설정: {snapshotLabel(testedSnapshot)}</p>
          )}

          <p className="border-t border-line pt-4 text-[13px] leading-relaxed text-inkSoft">
            API 키는 저장되지 않습니다 — 구독 CLI 또는 로컬 Ollama를 사용합니다. Codex CLI 지원은 best-effort입니다.
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
      {health.configured ? `${status.label} — ${health.detail}` : "먼저 설정을 저장한 뒤 연결을 테스트하세요."}
    </p>
  );
}
