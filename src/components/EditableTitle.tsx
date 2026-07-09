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

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && !saving;

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
      if (res.status === 409) setError("아직 요약이 끝나지 않아 이름을 바꿀 수 없어요.");
      else if (res.status === 404) setError("회의를 찾을 수 없어요. 이미 삭제되었을 수 있어요.");
      else setError("이름을 저장하지 못했어요. 잠시 후 다시 시도하세요.");
    } catch {
      setError("이름을 저장하지 못했어요. 잠시 후 다시 시도하세요.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-[14px] border border-line bg-panel px-5 py-4">
      <div className="min-w-0 flex-1">
        <input
          ref={inputRef}
          type="text"
          aria-label="회의 제목"
          value={value}
          disabled={saving}
          maxLength={200}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          className="w-full rounded-lg border border-line bg-bg px-3 py-1.5 text-[15px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        />
        {error && (
          <p role="status" aria-live="polite" className="mt-1 text-[12px] text-error">
            {error}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => void save()}
        disabled={!canSave}
        className="shrink-0 rounded-full bg-ink px-4 py-1.5 text-[13px] font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-50"
      >
        {saving ? "저장 중…" : "저장"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={saving}
        className="shrink-0 rounded-full border border-line bg-panel px-4 py-1.5 text-[13px] font-semibold text-accent transition-colors hover:bg-soft disabled:opacity-50"
      >
        취소
      </button>
    </div>
  );
}
