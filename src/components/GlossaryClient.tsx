"use client";

import { useEffect, useState } from "react";

import type { Correction, Glossary } from "@/domain/glossary";

// 단어 관리(단어장) editor. Two tabs — 일반 용어(terms) and 교정쌍(corrections) —
// edited in local state and saved together with one explicit "저장" button (app
// convention; no autosave). Fed to the LLM correction step, not whisper STT.

// Split bulk input on newlines and half/full-width commas — NOT spaces, so
// multi-word terms ("프로덕트 로드맵") stay intact.
function toTerms(input: string): string[] {
  return input
    .split(/[\n,，]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function GlossaryClient() {
  const [tab, setTab] = useState<"terms" | "corrections">("terms");
  const [terms, setTerms] = useState<string[]>([]);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // draft inputs
  const [termInput, setTermInput] = useState("");
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch("/api/glossary", { cache: "no-store" });
        const data = (await res.json()) as Glossary;
        if (!active) return;
        setTerms(data.terms ?? []);
        setCorrections(data.corrections ?? []);
      } catch {
        // Empty glossary is a fine starting point.
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const mutate = () => {
    setDirty(true);
    setSaved(false);
  };

  const addTerms = () => {
    const parsed = toTerms(termInput);
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

  const removeCorrection = (from: string) => {
    setCorrections((prev) => prev.filter((c) => c.from !== from));
    mutate();
  };

  const save = async () => {
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
      const data = (await res.json()) as Glossary; // normalized by the server
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

  return (
    <main id="main" className="max-w-2xl space-y-8 px-6 py-12">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">단어 관리</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-inkSoft">
          회의에서 자주 쓰는 용어와 자주 틀리는 표기를 등록하면, 요약 단계에서 이름·숫자 오인식을 줄일 수 있어요.
        </p>
      </div>

      <div className="space-y-6 rounded-[16px] border border-line bg-panel p-6 shadow-[0_1px_2px_rgba(42,36,32,.04)]">
        <div role="tablist" aria-label="단어장 탭" className="flex gap-1 border-b border-line">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "terms"}
            onClick={() => setTab("terms")}
            className={`-mb-px border-b-2 px-4 py-2.5 text-[14px] font-medium transition-colors ${
              tab === "terms" ? "border-accent text-ink" : "border-transparent text-inkSoft hover:text-ink"
            }`}
          >
            일반 용어 ({terms.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "corrections"}
            onClick={() => setTab("corrections")}
            className={`-mb-px border-b-2 px-4 py-2.5 text-[14px] font-medium transition-colors ${
              tab === "corrections" ? "border-accent text-ink" : "border-transparent text-inkSoft hover:text-ink"
            }`}
          >
            교정쌍 ({corrections.length})
          </button>
        </div>

        {tab === "terms" ? (
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
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTerms();
                  }
                }}
                placeholder="예: 프로덕트 로드맵, OKR"
                className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
              <button
                type="button"
                onClick={addTerms}
                className="shrink-0 rounded-lg border border-line bg-panel px-3 py-2 text-[13px] font-medium text-accent transition-colors hover:bg-soft"
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
                    className="inline-flex items-center gap-1.5 rounded-full bg-soft px-3 py-1 text-[13px] text-ink"
                  >
                    {t}
                    <button
                      type="button"
                      aria-label={`용어 삭제: ${t}`}
                      onClick={() => removeTerm(t)}
                      className="text-inkSoft transition-colors hover:text-error"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-[13px] leading-relaxed text-inkSoft">
              자주 틀리는 표기를 ‘잘못 인식된 표기(전) → 올바른 표기(후)’로 등록하세요. 새 회의는 자동 반영되고, 기존
              회의는 상세의 ‘다시 요약’으로 갱신됩니다.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                aria-label="잘못 인식된 표기(전)"
                value={fromInput}
                onChange={(e) => setFromInput(e.target.value)}
                placeholder="잘못 인식된 표기"
                className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
              <span aria-hidden="true" className="text-inkSoft">
                →
              </span>
              <input
                type="text"
                aria-label="올바른 표기(후)"
                value={toInput}
                onChange={(e) => setToInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canAddCorrection) {
                    e.preventDefault();
                    addCorrection();
                  }
                }}
                placeholder="올바른 표기"
                className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
              <button
                type="button"
                onClick={addCorrection}
                disabled={!canAddCorrection}
                className="shrink-0 rounded-lg border border-line bg-panel px-3 py-2 text-[13px] font-medium text-accent transition-colors hover:bg-soft disabled:opacity-50"
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
                    className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg px-3 py-2 text-[14px]"
                  >
                    <span className="min-w-0 truncate text-ink">
                      <span className="text-inkSoft line-through">{c.from}</span>
                      <span aria-hidden="true" className="mx-2 text-inkSoft">
                        →
                      </span>
                      {c.to}
                    </span>
                    <button
                      type="button"
                      aria-label={`교정쌍 삭제: ${c.from}`}
                      onClick={() => removeCorrection(c.from)}
                      className="shrink-0 text-inkSoft transition-colors hover:text-error"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex items-center gap-3 border-t border-line pt-4">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !loaded}
            className="rounded-full bg-ink px-5 py-2 text-[14px] font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-50"
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
      </div>
    </main>
  );
}
