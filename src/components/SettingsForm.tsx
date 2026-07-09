"use client";

import { type FormEvent, useEffect, useState } from "react";

import type { LlmProvider } from "@/services/llm/types";

// Settings form for the LLM summarizer backend. app-api owns data/settings.json;
// this UI never handles an API key — it only picks a provider you're already signed
// into (Claude/Codex CLI) or a local model (Ollama).

type HealthResult =
  | { configured: false }
  | { configured: true; provider: string; ok: boolean; detail: string };

const PROVIDERS: { value: LlmProvider; label: string; hint: string }[] = [
  { value: "claude-cli", label: "Claude CLI", hint: "구독 CLI 사용 · 권장" },
  { value: "codex-cli", label: "Codex CLI", hint: "구독 CLI 사용 · 지원은 best-effort" },
  { value: "ollama", label: "Ollama", hint: "로컬 모델 · 모델명이 필요합니다" },
];

const field =
  "w-full rounded-md border border-line bg-panel px-3 py-2 text-[14px] text-ink placeholder:text-inkSoft focus:border-accent focus:outline-none";

export function SettingsForm() {
  const [provider, setProvider] = useState<LlmProvider>("claude-cli");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [health, setHealth] = useState<HealthResult | null>(null);

  // Load current settings once on mount.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch("/api/settings/llm", { cache: "no-store" });
        const data = (await res.json()) as {
          provider: LlmProvider | null;
          model?: string;
          baseUrl?: string;
        };
        if (!active) return;
        if (data.provider) setProvider(data.provider);
        setModel(data.model ?? "");
        setBaseUrl(data.baseUrl ?? "");
      } catch {
        // Keep defaults on a transient read failure.
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const isOllama = provider === "ollama";

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const body: { provider: LlmProvider; model?: string; baseUrl?: string } = { provider };
      if (model.trim()) body.model = model.trim();
      if (isOllama && baseUrl.trim()) body.baseUrl = baseUrl.trim();
      const res = await fetch("/api/settings/llm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSaved(true);
        setHealth(null);
      }
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setHealth(null);
    try {
      const res = await fetch("/api/settings/llm/health", { cache: "no-store" });
      setHealth((await res.json()) as HealthResult);
    } catch {
      setHealth({ configured: true, provider, ok: false, detail: "연결 테스트 요청에 실패했습니다." });
    } finally {
      setTesting(false);
    }
  };

  return (
    <main id="main" className="max-w-2xl space-y-8 px-6 py-12">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">요약 모델 설정</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-inkSoft">
          회의록 요약에 사용할 모델을 선택합니다. 녹음·전사는 모델 없이도 동작하며, 요약만 모델이 필요합니다.
        </p>
      </div>

      <form
        onSubmit={(e) => void submit(e)}
        className="space-y-6 rounded-[16px] border border-line bg-panel p-6 shadow-[0_1px_2px_rgba(42,36,32,.04)]"
      >
        <fieldset className="space-y-3">
          <legend className="text-[14px] font-bold text-ink">모델 백엔드</legend>
          <div className="space-y-2">
            {PROVIDERS.map((p) => (
              <label
                key={p.value}
                className={`flex cursor-pointer items-start gap-3 rounded-[12px] border px-4 py-3 transition-colors ${
                  provider === p.value ? "border-accent bg-soft" : "border-line bg-panel hover:bg-chrome"
                }`}
              >
                <input
                  type="radio"
                  name="provider"
                  value={p.value}
                  checked={provider === p.value}
                  onChange={() => {
                    setProvider(p.value);
                    setSaved(false);
                    setHealth(null);
                  }}
                  className="mt-0.5 accent-accent"
                />
                <span>
                  <span className="block text-[14px] font-semibold text-ink">{p.label}</span>
                  <span className="mt-0.5 block text-[13px] text-inkSoft">{p.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="block">
          <span className="text-[13px] font-medium text-inkSoft">
            모델 {isOllama ? "(필수)" : "(선택)"}
          </span>
          <input
            className={`mt-1 ${field}`}
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setSaved(false);
            }}
            placeholder={isOllama ? "예: llama3.1" : "비워두면 기본 모델을 사용합니다"}
          />
        </label>

        {isOllama && (
          <label className="block">
            <span className="text-[13px] font-medium text-inkSoft">Base URL (선택)</span>
            <input
              className={`mt-1 ${field}`}
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setSaved(false);
              }}
              placeholder="http://127.0.0.1:11434"
            />
          </label>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={saving || !loaded}
            className="rounded-full bg-ink px-5 py-2 text-[14px] font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-50"
          >
            {saving ? "저장 중…" : "저장"}
          </button>
          <button
            type="button"
            onClick={() => void test()}
            disabled={testing}
            className="rounded-full border border-line bg-panel px-5 py-2 text-[14px] font-semibold text-accent transition-colors hover:bg-soft disabled:opacity-50"
          >
            {testing ? "테스트 중…" : "연결 테스트"}
          </button>
          {saved && <span className="text-[13px] text-success">저장됨</span>}
        </div>

        {health && (
          <p
            role="status"
            className={`rounded-md px-3 py-2 text-[13px] ${
              !health.configured
                ? "bg-warnBg text-warn"
                : health.ok
                  ? "bg-successBg text-success"
                  : "bg-error/10 text-error"
            }`}
          >
            {!health.configured
              ? "먼저 설정을 저장한 뒤 연결을 테스트하세요."
              : health.ok
                ? `연결됨 — ${health.detail}`
                : `연결 실패 — ${health.detail}`}
          </p>
        )}

        <p className="border-t border-line pt-4 text-[13px] leading-relaxed text-inkSoft">
          API 키는 저장되지 않습니다 — 구독 CLI 또는 로컬 Ollama를 사용합니다. Codex CLI 지원은 best-effort입니다.
        </p>
      </form>
    </main>
  );
}
