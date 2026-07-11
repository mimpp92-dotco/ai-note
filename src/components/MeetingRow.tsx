"use client";

import { useEffect, useRef, useState } from "react";

import { EditableTitle } from "@/components/EditableTitle";
import { KebabVerticalIcon } from "@/components/InlineIcons";
import { LibraryLocationPicker } from "@/components/LibraryLocationPicker";
import { useOptionalLibrary } from "@/components/LibraryProvider";
import { GuardedLink as Link } from "@/components/RecorderNavigation";
import type { MeetingListItem } from "@/components/MeetingList";
import type { MeetingStatus, StatusError } from "@/domain/meeting";
import { formatMeetingDate, STATUS_LABELS } from "@/lib/meetingLabels";

type Mode = "idle" | "menu" | "editing" | "moving" | "confirming";

// One meeting card + its row actions (kebab → 이름 수정 / 삭제). The kebab and its
// menu are siblings of the card <Link> (interactive controls cannot nest inside an
// anchor). 이름 수정 is offered only once summarized; 삭제 is always available.
export function MeetingRow({
  meeting,
  detailHref,
  onRenamed,
  onDeleted,
  onMoved,
}: {
  meeting: MeetingListItem;
  detailHref?: string;
  onRenamed: (id: string, title: string) => void;
  onDeleted: (id: string) => void;
  onMoved?: (id: string, actual: { workspaceId: string; folderId: string | null }) => void;
}) {
  const library = useOptionalLibrary();
  const [mode, setMode] = useState<Mode>("idle");
  const [deleting, setDeleting] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);
  const containerRef = useRef<HTMLLIElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const canRename = meeting.status === "summarized";
  const canMove = library?.mode === "ready" && library.version !== null && library.library !== null;

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
      <li className="min-w-0">
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
        href={detailHref ?? `/meetings/${meeting.id}`}
        className="flex w-full min-w-0 self-stretch flex-col items-start justify-between gap-2 rounded-[14px] border border-line bg-panel py-4 pl-4 pr-16 shadow-[0_1px_2px_rgba(42,36,32,.04)] transition-colors hover:bg-chrome focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:flex-row sm:items-center sm:gap-4 sm:pl-6"
      >
        <span className="w-full min-w-0">
          <span className="block truncate text-[15px] font-semibold text-ink">{meeting.title}</span>
          <span className="mt-0.5 block font-mono text-[12px] text-inkSoft">
            {formatMeetingDate(meeting.startedAt)}
          </span>
          {meeting.location && (
            <span className="mt-1 block truncate text-[12px] text-inkSoft">
              {meeting.location.breadcrumb.length > 0
                ? meeting.location.breadcrumb.join(" / ")
                : "미분류"}
            </span>
          )}
        </span>
        <StatusBadge status={meeting.status} error={meeting.error} />
      </Link>

      <div className="absolute right-2 top-1/2 -translate-y-1/2 sm:right-3">
        <button
          ref={triggerRef}
          type="button"
          aria-label={`${meeting.title} 관리 메뉴`}
          aria-expanded={mode === "menu"}
          onClick={() => setMode((m) => (m === "menu" ? "idle" : "menu"))}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-inkSoft transition-colors hover:bg-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <KebabVerticalIcon />
        </button>
      </div>

      {mode === "menu" && (
        <div className="absolute right-3 top-12 z-40 w-32 overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-[0_8px_28px_-12px_rgba(42,36,32,.18)]">
          {canMove && (
            <button
              type="button"
              onClick={() => setMode("moving")}
              className="flex min-h-11 w-full items-center px-4 text-left text-[13px] text-ink hover:bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
            >
              이동
            </button>
          )}
          {canRename && (
            <button
              type="button"
              onClick={() => setMode("editing")}
              className="flex min-h-11 w-full items-center px-4 text-left text-[13px] text-ink hover:bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
            >
              이름 수정
            </button>
          )}
          <button
            type="button"
            onClick={() => setMode("confirming")}
            className="flex min-h-11 w-full items-center px-4 text-left text-[13px] text-error hover:bg-error/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-error/50"
          >
            삭제
          </button>
        </div>
      )}

      {mode === "moving" && canMove && (
        <LibraryLocationPicker
          kind="meeting"
          meetingId={meeting.id}
          current={meeting.location
            ? { workspaceId: meeting.location.workspaceId, folderId: meeting.location.folderId }
            : null}
          trigger={triggerRef.current}
          onClose={() => setMode("idle")}
          onMoved={(actual) => {
            const row = containerRef.current;
            const next = row?.nextElementSibling?.querySelector<HTMLButtonElement>("button[aria-label$='관리 메뉴']");
            const previous = row?.previousElementSibling?.querySelector<HTMLButtonElement>("button[aria-label$='관리 메뉴']");
            setMode("idle");
            onMoved?.(meeting.id, actual);
            window.setTimeout(() => {
              if (document.contains(triggerRef.current)) triggerRef.current?.focus();
              else (next ?? previous ?? document.querySelector<HTMLElement>("#main h1"))?.focus();
            }, 0);
          }}
        />
      )}

      {mode === "confirming" && (
        <div className="mt-2 min-w-0 rounded-[14px] border border-error/40 bg-error/5 p-4 sm:px-6">
          <p className="break-words text-[14px] text-ink">
            ‘{meeting.title}’ 회의록을 영구 삭제할까요? 되돌릴 수 없어요.
          </p>
          {delError && (
            <p role="status" aria-live="polite" className="mt-1 text-[12px] text-error">
              {delError}
            </p>
          )}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={() => void doDelete()}
              disabled={deleting}
              className="min-h-11 w-full rounded-lg bg-error px-4 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/50 disabled:opacity-50 sm:w-auto"
            >
              {deleting ? "삭제 중…" : "영구 삭제"}
            </button>
            <button
              ref={cancelRef}
              type="button"
              onClick={() => setMode("idle")}
              disabled={deleting}
              className="min-h-11 w-full rounded-lg border border-line bg-panel px-4 text-[13px] font-semibold text-accent transition-colors hover:bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50 sm:w-auto"
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
