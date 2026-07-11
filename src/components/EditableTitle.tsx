"use client";

import { useEffect, useRef, useState } from "react";

// Inline title editor for a meeting row. Enter = save, Esc = cancel. Skips the
// POST when unchanged. On failure it stays in edit mode and surfaces the reason
// (aria-live) so a 409 (not summarized) / 404 (deleted meanwhile) is visible.
export function EditableTitle({
  id,
  initialTitle,
  onSaved,
  onCancel,
}: {
  id: string;
  initialTitle: string;
  onSaved: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialTitle);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (!saving && error) inputRef.current?.focus();
  }, [error, saving]);

  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && !saving;

  const keepEditingWithError = (message: string) => {
    setError(message);
  };

  const save = async () => {
    if (trimmed.length === 0 || saving) return;
    if (trimmed === initialTitle.trim()) {
      onCancel(); // no change → no write
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/meetings/${id}/title`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (res.ok) {
        onSaved(trimmed);
        return;
      }
      if (res.status === 409) keepEditingWithError("아직 요약이 끝나지 않아 이름을 바꿀 수 없어요.");
      else if (res.status === 404) keepEditingWithError("회의를 찾을 수 없어요. 이미 삭제되었을 수 있어요.");
      else keepEditingWithError("이름을 저장하지 못했어요. 잠시 후 다시 시도하세요.");
    } catch {
      keepEditingWithError("이름을 저장하지 못했어요. 잠시 후 다시 시도하세요.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-[14px] border border-line bg-panel p-4 sm:flex-row sm:items-start sm:px-6">
      <div className="w-full min-w-0 flex-1">
        <input
          ref={inputRef}
          type="text"
          aria-label="회의 제목"
          value={value}
          disabled={saving}
          maxLength={200}
          onChange={(e) => setValue(e.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (e.nativeEvent.isComposing || e.keyCode === 229 || composingRef.current) return;
              e.preventDefault();
              void save();
            } else if (e.key === "Escape") {
              if (e.nativeEvent.isComposing || composingRef.current) return;
              e.preventDefault();
              onCancel();
            }
          }}
          className="min-h-11 w-full rounded-lg border border-line bg-bg px-3 text-[15px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        />
        {error && (
          <p role="status" aria-live="polite" className="mt-1 text-[12px] text-error">
            {error}
          </p>
        )}
      </div>
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSave}
          className="min-h-11 w-full shrink-0 rounded-lg bg-ink px-4 text-[13px] font-semibold text-bg transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50 sm:w-auto"
        >
          {saving ? "저장 중…" : "저장"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="min-h-11 w-full shrink-0 rounded-lg border border-line bg-panel px-4 text-[13px] font-semibold text-accent transition-colors hover:bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50 sm:w-auto"
        >
          취소
        </button>
      </div>
    </div>
  );
}
