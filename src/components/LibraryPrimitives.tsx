"use client";

import {
  type RefObject,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";

import { AppDialog } from "@/components/AppDialog";

export function LibraryDialogShell({
  open,
  title,
  onClose,
  trigger = null,
  initialFocusRef,
  busy = false,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  trigger?: HTMLElement | null;
  initialFocusRef?: RefObject<HTMLElement>;
  busy?: boolean;
  children: ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <AppDialog
      open={open}
      title={title}
      initialFocusRef={initialFocusRef ?? cancelRef}
      returnFocus={trigger}
      dismissible={!busy}
      onDismiss={() => onClose()}
    >
      {(dismiss) => (
        <>
        <div className="mt-4">{children}</div>
        <div className="mt-5 flex justify-end">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={() => dismiss("explicit_cancel")}
            className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent"
          >
            취소
          </button>
        </div>
        </>
      )}
    </AppDialog>
  );
}

export function LibraryDrawerShell({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] bg-ink/30 md:hidden">
      <aside role="dialog" aria-modal="true" aria-labelledby={titleId} className="min-h-full w-[min(88vw,22rem)] border-r border-line bg-panel p-5 shadow-xl">
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-[17px] font-bold text-ink">{title}</h2>
          <button type="button" aria-label={`${title} 닫기`} onClick={onClose} className="min-h-11 min-w-11 rounded-full border border-line text-ink">
            ×
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </aside>
    </div>
  );
}

export function DisclosureNavigationItem({
  label,
  defaultExpanded = false,
  children,
}: {
  label: string;
  defaultExpanded?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const contentId = useId();
  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
        className="min-h-11 w-full text-left text-[14px] font-medium text-ink"
      >
        {label}
      </button>
      {expanded && <ul id={contentId}>{children}</ul>}
    </li>
  );
}
