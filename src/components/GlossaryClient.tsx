"use client";

import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

import { CloseIcon } from "@/components/InlineIcons";
import { Tabs } from "@/components/Tabs";
import type { Correction, Glossary } from "@/domain/glossary";

// 단어 관리(단어장) editor. Two tabs — 일반 용어(terms) and 교정쌍(corrections) —
// edited in local state and saved together with one explicit "저장" button (app
// convention; no autosave). Fed to the LLM correction step, not whisper STT.
//
// Load/save are fail-closed: an initial GET failure is a distinct `load_error`, never
// an empty glossary, so a replace-style save cannot silently wipe the stored file.

type LoadState = "loading" | "ready" | "load_error";

// Split bulk input on newlines and half/full-width commas — NOT spaces, so
// multi-word terms ("프로덕트 로드맵") stay intact.
function toTerms(input: string): string[] {
  return input
    .split(/[\n,，]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// Only trust a success body that matches the public { terms, corrections } shape.
// A 200 with an unexpected shape is treated as a load failure, not an empty glossary.
function isGlossaryShape(data: unknown): data is Glossary {
  if (typeof data !== "object" || data === null) return false;
  const value = data as { terms?: unknown; corrections?: unknown };
  if (!Array.isArray(value.terms) || !value.terms.every((t) => typeof t === "string")) return false;
  if (!Array.isArray(value.corrections)) return false;
  return value.corrections.every(
    (c) =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as Correction).from === "string" &&
      typeof (c as Correction).to === "string",
  );
}

export function GlossaryClient() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [terms, setTerms] = useState<string[]>([]);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [tab, setTab] = useState<"terms" | "corrections">("terms");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // draft inputs
  const [termInput, setTermInput] = useState("");
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const termComposingRef = useRef(false);
  const correctionComposingRef = useRef(false);

  // Abort the previous read so a retry (or unmount) can't let a stale response win.
  const loadAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoadState("loading");
    setError(null);
    try {
      const res = await fetch("/api/glossary", { cache: "no-store", signal: controller.signal });
      if (!res.ok) throw new Error("load failed");
      const data: unknown = await res.json();
      if (controller.signal.aborted) return;
      if (!isGlossaryShape(data)) throw new Error("invalid body");
      setTerms(data.terms);
      setCorrections(data.corrections);
      setDirty(false);
      setSaved(false);
      setError(null);
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

  const mutate = () => {
    setDirty(true);
    setSaved(false);
  };

  const addTerms = (raw = termInput) => {
    const parsed = toTerms(raw);
    if (parsed.length === 0) return;
    setTerms((prev) => Array.from(new Set([...prev, ...parsed])));
    setTermInput("");
    mutate();
  };

  const removeTerm = (t: string) => {
    setTerms((prev) => prev.filter((x) => x !== t));
    mutate();
  };

  const canAddCorrection =
    fromInput.trim().length > 0 && toInput.trim().length > 0 && fromInput.trim() !== toInput.trim();

  const addCorrection = () => {
    const from = fromInput.trim();
    const to = toInput.trim();
    if (!from || !to || from === to) return;
    if (corrections.some((c) => c.from === from)) {
      setError(`이미 등록된 표기예요: ‘${from}’`);
      return;
    }
    setCorrections((prev) => [...prev, { from, to }]);
    setFromInput("");
    setToInput("");
    setError(null);
    mutate();
  };

  const isComposingEnter = (e: KeyboardEvent<HTMLInputElement>, ref: React.MutableRefObject<boolean>) =>
    ref.current || e.nativeEvent.isComposing || e.keyCode === 229;

  const removeCorrection = (from: string) => {
    setCorrections((prev) => prev.filter((c) => c.from !== from));
    mutate();
  };

  const ready = loadState === "ready";
  const canSave = ready && dirty && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/glossary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ terms, corrections }),
      });
      if (!res.ok) {
        setError("저장하지 못했어요. 잠시 후 다시 시도하세요.");
        return;
      }
      const data: unknown = await res.json(); // normalized by the server
      if (!isGlossaryShape(data)) {
        setError("저장하지 못했어요. 잠시 후 다시 시도하세요.");
        return;
      }
      setTerms(data.terms);
      setCorrections(data.corrections);
      setDirty(false);
      setSaved(true);
    } catch {
      setError("저장하지 못했어요. 잠시 후 다시 시도하세요.");
    } finally {
      setSaving(false);
    }
  };

  const termsPanel = (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-inkSoft">
        자주 나오는 이름·제품·전문 용어를 등록하세요. 쉼표(,)나 줄바꿈으로 여러 개를 한 번에 추가할 수 있어요.
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          aria-label="용어 추가"
          value={termInput}
          onChange={(e) => setTermInput(e.target.value)}
          onCompositionStart={() => {
            termComposingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            termComposingRef.current = false;
            setTermInput(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (isComposingEnter(e, termComposingRef)) return;
              e.preventDefault();
              addTerms(e.currentTarget.value);
            }
          }}
          placeholder="예: 프로덕트 로드맵, OKR"
          className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        />
        <button
          type="button"
          onClick={() => addTerms()}
          className="min-h-11 shrink-0 rounded-lg border border-line bg-panel px-3 text-[13px] font-medium text-accent transition-colors hover:bg-soft"
        >
          추가
        </button>
      </div>
      {terms.length === 0 ? (
        <p className="text-[13px] text-inkSoft">
          등록된 용어가 없어요. 자주 나오는 이름·제품·전문 용어를 추가해 보세요.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {terms.map((t) => (
            <li
              key={t}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-soft py-1 pl-3 pr-1 text-[13px] text-ink"
            >
              <span className="min-w-0 break-words">{t}</span>
              <button
                type="button"
                aria-label={`용어 삭제: ${t}`}
                onClick={() => removeTerm(t)}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-inkSoft transition-colors hover:bg-panel hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const correctionsPanel = (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-inkSoft">
        자주 틀리는 표기를 ‘잘못 인식된 표기(전) → 올바른 표기(후)’로 등록하세요. 새 회의는 자동 반영되고, 기존
        회의는 상세의 ‘다시 요약’으로 갱신됩니다.
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="block min-w-0 flex-1">
          <span className="mb-1 block text-[13px] font-medium text-inkSoft">잘못 인식된 표기(전)</span>
          <input
            type="text"
            value={fromInput}
            onChange={(e) => setFromInput(e.target.value)}
            placeholder="잘못 인식된 표기"
            className="w-full min-w-0 rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          />
        </label>
        <span aria-hidden="true" className="hidden shrink-0 pb-2 text-inkSoft sm:block">
          →
        </span>
        <label className="block min-w-0 flex-1">
          <span className="mb-1 block text-[13px] font-medium text-inkSoft">올바른 표기(후)</span>
          <input
            type="text"
            value={toInput}
            onChange={(e) => setToInput(e.target.value)}
            onCompositionStart={() => {
              correctionComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              correctionComposingRef.current = false;
              setToInput(e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canAddCorrection) {
                if (isComposingEnter(e, correctionComposingRef)) return;
                e.preventDefault();
                addCorrection();
              }
            }}
            placeholder="올바른 표기"
            className="w-full min-w-0 rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          />
        </label>
        <button
          type="button"
          onClick={addCorrection}
          disabled={!canAddCorrection}
          className="min-h-11 shrink-0 rounded-lg border border-line bg-panel px-3 text-[13px] font-medium text-accent transition-colors hover:bg-soft disabled:opacity-50"
        >
          추가
        </button>
      </div>
      {corrections.length === 0 ? (
        <p className="text-[13px] text-inkSoft">
          등록된 교정쌍이 없어요. 자주 틀리는 표기를 ‘잘못된 표기 → 올바른 표기’로 등록하세요.
        </p>
      ) : (
        <ul className="space-y-2">
          {corrections.map((c) => (
            <li
              key={c.from}
              className="flex items-start justify-between gap-3 rounded-lg border border-line bg-bg px-3 py-2 text-[14px]"
            >
              <span className="min-w-0 flex-1 break-words text-ink">
                <span className="break-words text-inkSoft line-through">{c.from}</span>
                <span aria-hidden="true" className="mx-2 text-inkSoft">
                  →
                </span>
                <span className="break-words">{c.to}</span>
              </span>
              <button
                type="button"
                aria-label={`교정쌍 삭제: ${c.from}`}
                onClick={() => removeCorrection(c.from)}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-inkSoft transition-colors hover:bg-panel hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <main id="main" className="max-w-2xl space-y-8 px-4 py-12 sm:px-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">단어 관리</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-inkSoft">
          회의에서 자주 쓰는 용어와 자주 틀리는 표기를 등록하면, 요약 단계에서 이름·숫자 오인식을 줄일 수 있어요.
        </p>
      </div>

      <div className="space-y-6 rounded-[16px] border border-line bg-panel p-4 shadow-[0_1px_2px_rgba(42,36,32,.04)] sm:p-6">
        {loadState === "loading" && (
          <p role="status" className="text-[14px] text-inkSoft">
            단어장을 불러오는 중…
          </p>
        )}

        {loadState === "load_error" && (
          <div className="space-y-3">
            <p role="status" className="text-[14px] text-error">
              단어장을 불러오지 못했어요. 저장하면 기존 내용을 덮어쓸 수 있어 편집을 잠갔습니다.
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
          <>
            <Tabs<"terms" | "corrections">
              ariaLabel="단어장 탭"
              value={tab}
              onValueChange={setTab}
              items={[
                { value: "terms", label: `일반 용어 (${terms.length})`, content: termsPanel },
                { value: "corrections", label: `교정쌍 (${corrections.length})`, content: correctionsPanel },
              ]}
            />

            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
              <button
                type="button"
                onClick={() => void save()}
                disabled={!canSave}
                className="min-h-11 rounded-full bg-ink px-5 text-[14px] font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-50"
              >
                {saving ? "저장 중…" : "저장"}
              </button>
              {saved && !dirty && <span className="text-[13px] text-success">저장됨</span>}
              {dirty && !saving && <span className="text-[13px] text-inkSoft">변경됨</span>}
              {error && (
                <span role="status" aria-live="polite" className="text-[13px] text-error">
                  {error}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
