"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { EditableTitle } from "@/components/EditableTitle";
import type { MeetingListItem } from "@/components/MeetingList";
import type { MeetingStatus, StatusError } from "@/domain/meeting";
import { formatMeetingDate, STATUS_LABELS } from "@/lib/meetingLabels";

type Mode = "idle" | "menu" | "editing" | "confirming";

// One meeting card + its row actions (kebab → 이름 수정 / 삭제). The kebab and its
// menu are siblings of the card <Link> (interactive controls cannot nest inside an
// anchor). 이름 수정 is offered only once summarized; 삭제 is always available.
export function MeetingRow({
  meeting,
  onRenamed,
  onDeleted,
}: {
  meeting: MeetingListItem;
  onRenamed: (id: string, title: string) => void;
  onDeleted: (id: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("idle");
  const [deleting, setDeleting] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);
  const containerRef = useRef<HTMLLIElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const canRename = meeting.status === "summarized";

  // Close the menu on an outside click (only while the menu is open, so it never
  // interferes with the edit/confirm sub-UIs).
  useEffect(() => {
    if (mode !== "menu") return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setMode("idle");
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMode("idle");
      triggerRef.current?.focus();
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [mode]);

  // Confirm dialog opens with focus on 취소 to avoid an accidental Enter-delete.
  useEffect(() => {
    if (mode === "confirming") cancelRef.current?.focus();
  }, [mode]);

  const doDelete = async () => {
    setDeleting(true);
    setDelError(null);
    try {
      const res = await fetch(`/api/meetings/${meeting.id}`, { method: "DELETE" });
      if (res.ok || res.status === 404) {
        onDeleted(meeting.id); // 404 = already gone → treat as success
        return;
      }
      if (res.status === 409) setDelError("요약 중에는 삭제할 수 없어요. 잠시 후 다시 시도하세요.");
      else setDelError("삭제하지 못했어요. 잠시 후 다시 시도하세요.");
    } catch {
      setDelError("삭제하지 못했어요. 잠시 후 다시 시도하세요.");
    } finally {
      setDeleting(false);
    }
  };

  if (mode === "editing") {
    return (
      <li>
        <EditableTitle
          id={meeting.id}
          initialTitle={meeting.title}
          onSaved={(title) => {
            setMode("idle");
            onRenamed(meeting.id, title);
          }}
          onCancel={() => setMode("idle")}
        />
      </li>
    );
  }

  return (
    <li ref={containerRef} className={`relative min-w-0 ${mode === "menu" ? "z-30" : "z-0"}`}>
      <Link
        href={`/meetings/${meeting.id}`}
        className="flex min-w-0 flex-col items-start justify-between gap-2 rounded-[14px] border border-line bg-panel py-4 pl-5 pr-14 shadow-[0_1px_2px_rgba(42,36,32,.04)] transition-colors hover:bg-chrome sm:flex-row sm:items-center sm:gap-4"
      >
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold text-ink">{meeting.title}</span>
          <span className="mt-0.5 block font-mono text-[12px] text-inkSoft">
            {formatMeetingDate(meeting.startedAt)}
          </span>
        </span>
        <StatusBadge status={meeting.status} error={meeting.error} />
      </Link>

      <div className="absolute right-3 top-1/2 -translate-y-1/2">
        <button
          ref={triggerRef}
          type="button"
          aria-label={`${meeting.title} 관리 메뉴`}
          aria-expanded={mode === "menu"}
          onClick={() => setMode((m) => (m === "menu" ? "idle" : "menu"))}
          className="flex h-8 w-8 items-center justify-center rounded-full text-inkSoft transition-colors hover:bg-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
            <circle cx="12" cy="5" r="1.5" fill="currentColor" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            <circle cx="12" cy="19" r="1.5" fill="currentColor" />
          </svg>
        </button>
      </div>

      {mode === "menu" && (
        <div className="absolute right-3 top-12 z-40 w-32 overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-[0_8px_28px_-12px_rgba(42,36,32,.18)]">
          {canRename && (
            <button
              type="button"
              onClick={() => setMode("editing")}
              className="block w-full px-4 py-2 text-left text-[13px] text-ink hover:bg-soft"
            >
              이름 수정
            </button>
          )}
          <button
            type="button"
            onClick={() => setMode("confirming")}
            className="block w-full px-4 py-2 text-left text-[13px] text-error hover:bg-error/10"
          >
            삭제
          </button>
        </div>
      )}

      {mode === "confirming" && (
        <div className="mt-2 rounded-[14px] border border-error/40 bg-error/5 px-5 py-4">
          <p className="text-[14px] text-ink">
            ‘{meeting.title}’ 회의록을 영구 삭제할까요? 되돌릴 수 없어요.
          </p>
          {delError && (
            <p role="status" aria-live="polite" className="mt-1 text-[12px] text-error">
              {delError}
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void doDelete()}
              disabled={deleting}
              className="rounded-full bg-error px-4 py-1.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {deleting ? "삭제 중…" : "영구 삭제"}
            </button>
            <button
              ref={cancelRef}
              type="button"
              onClick={() => setMode("idle")}
              disabled={deleting}
              className="rounded-full border border-line bg-panel px-4 py-1.5 text-[13px] font-semibold text-accent transition-colors hover:bg-soft disabled:opacity-50"
            >
              취소
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function StatusBadge({ status, error }: { status: MeetingStatus; error: StatusError | null }) {
  if (error?.action === "retry_summary") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-error/10 px-3 py-1 text-[12px] font-medium text-error">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-error" aria-hidden="true" />
        요약 실패
      </span>
    );
  }

  if (status === "summarizing") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-soft px-3 py-1 text-[12px] font-medium text-inkSoft">
        <span
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
          aria-hidden="true"
        />
        요약 중
      </span>
    );
  }

  return (
    <span className="shrink-0 rounded-full bg-soft px-3 py-1 text-[12px] font-medium text-inkSoft">
      {STATUS_LABELS[status]}
    </span>
  );
}
