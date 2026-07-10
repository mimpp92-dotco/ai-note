"use client";

import {
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

export function LibraryDialogShell({
  open,
  title,
  onClose,
  trigger = null,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  trigger?: HTMLElement | null;
  children: ReactNode;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onClose();
      window.setTimeout(() => trigger?.focus(), 0);
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [onClose, open, trigger]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/35 p-4">
      <section role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-md rounded-2xl border border-line bg-panel p-6 shadow-xl">
        <h2 id={titleId} className="text-[18px] font-bold text-ink">{title}</h2>
        <div className="mt-4">{children}</div>
        <div className="mt-5 flex justify-end">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => {
              onClose();
              window.setTimeout(() => trigger?.focus(), 0);
            }}
            className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent"
          >
            취소
          </button>
        </div>
      </section>
    </div>
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
