"use client";

import { type RefObject, type ReactNode, useRef } from "react";

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
