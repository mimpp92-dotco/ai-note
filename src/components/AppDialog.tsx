"use client";

import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
} from "react";

export type AppDialogDismissReason = "escape" | "backdrop" | "explicit_cancel";
export type AppDialogDismiss = (reason: AppDialogDismissReason) => void;

type FocusTarget = HTMLElement | RefObject<HTMLElement> | null;

type AppDialogProps = {
  open: boolean;
  title: string;
  onDismiss: (reason: AppDialogDismissReason) => void;
  children: ReactNode | ((dismiss: AppDialogDismiss) => ReactNode);
  initialFocusRef?: RefObject<HTMLElement>;
  returnFocus?: FocusTarget;
  dismissible?: boolean;
  className?: string;
  panelClassName?: string;
  titleClassName?: string;
  presentation?: "dialog" | "drawer";
};

let bodyScrollLockCount = 0;
let bodyOverflowBeforeLock: string | null = null;

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function acquireBodyScrollLock(registration: { current: boolean }) {
  if (registration.current) return;
  registration.current = true;
  if (bodyScrollLockCount === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  bodyScrollLockCount += 1;
}

function releaseBodyScrollLock(registration: { current: boolean }) {
  if (!registration.current) return;
  registration.current = false;
  bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
  if (bodyScrollLockCount !== 0) return;
  document.body.style.overflow = bodyOverflowBeforeLock ?? "";
  bodyOverflowBeforeLock = null;
}

function resolveFocusTarget(target: FocusTarget | undefined): HTMLElement | null {
  if (!target) return null;
  return "current" in target ? target.current : target;
}

function isFocusable(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element.closest("[inert]")) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  return element.matches(FOCUSABLE_SELECTOR);
}

function focusFallback() {
  const openDialogs = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")];
  const underlying = openDialogs.at(-1);
  const safeControl = underlying?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
  const target = safeControl
    ?? underlying?.querySelector<HTMLElement>("[data-app-dialog-heading]")
    ?? document.querySelector<HTMLElement>("#main h1");
  target?.focus();
}

export function AppDialog({
  open,
  title,
  onDismiss,
  children,
  initialFocusRef,
  returnFocus = null,
  dismissible = true,
  className = "",
  panelClassName = "p-6",
  titleClassName = "text-[18px] font-bold text-ink",
  presentation = "dialog",
}: AppDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const lockRegistrationRef = useRef(false);
  const wasOpenRef = useRef(false);
  const returnFocusPendingRef = useRef(false);
  const backdropPressStartedRef = useRef(false);
  const openRef = useRef(open);
  const onDismissRef = useRef(onDismiss);
  const dismissibleRef = useRef(dismissible);
  const initialFocusRefRef = useRef(initialFocusRef);
  const returnFocusRef = useRef<FocusTarget>(returnFocus);

  openRef.current = open;
  onDismissRef.current = onDismiss;
  dismissibleRef.current = dismissible;
  initialFocusRefRef.current = initialFocusRef;
  returnFocusRef.current = returnFocus;

  const returnFocusAfterDismiss = useCallback(() => {
    if (!returnFocusPendingRef.current) return;
    returnFocusPendingRef.current = false;
    window.setTimeout(() => {
      const target = resolveFocusTarget(returnFocusRef.current);
      if (isFocusable(target)) {
        target.focus();
        return;
      }
      focusFallback();
    }, 0);
  }, []);

  const requestDismiss = useCallback<AppDialogDismiss>((reason) => {
    if (!dismissibleRef.current) return;
    returnFocusPendingRef.current = true;
    onDismissRef.current(reason);
    window.setTimeout(() => {
      if (openRef.current) returnFocusPendingRef.current = false;
    }, 0);
  }, []);

  const dialogClassName = presentation === "drawer"
    ? "m-0 h-dvh max-h-dvh w-screen max-w-none overflow-hidden border-0 bg-transparent p-0 text-ink backdrop:bg-ink/35"
    : "m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-hidden rounded-[16px] border border-line bg-panel p-0 text-ink shadow-xl backdrop:bg-ink/35";
  const panelBaseClassName = presentation === "drawer"
    ? "h-dvh max-h-dvh overflow-y-auto"
    : "max-h-[calc(100dvh-2rem)] overflow-y-auto";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
      wasOpenRef.current = true;
      initialFocusRefRef.current?.current?.focus();
      return;
    }
    if (dialog.open) dialog.close();
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      returnFocusAfterDismiss();
    }
  }, [open, returnFocusAfterDismiss]);

  useEffect(() => {
    if (open) acquireBodyScrollLock(lockRegistrationRef);
    else releaseBodyScrollLock(lockRegistrationRef);
  }, [open]);

  useEffect(() => () => {
    releaseBodyScrollLock(lockRegistrationRef);
    returnFocusAfterDismiss();
  }, [returnFocusAfterDismiss]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-modal="true"
      className={`${dialogClassName} ${className}`}
      onCancel={(event) => {
        event.preventDefault();
        requestDismiss("escape");
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab" || event.defaultPrevented) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("dialog") !== event.currentTarget) return;
        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
          .filter((element) => element.closest("dialog") === event.currentTarget && isFocusable(element));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) {
          event.preventDefault();
          event.currentTarget.querySelector<HTMLElement>("[data-app-dialog-heading]")?.focus();
          return;
        }
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }}
      onPointerDown={(event) => {
        backdropPressStartedRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const startedOnBackdrop = backdropPressStartedRef.current;
        backdropPressStartedRef.current = false;
        if (event.target === event.currentTarget && startedOnBackdrop) {
          requestDismiss("backdrop");
        }
      }}
    >
      <div className={`${panelBaseClassName} ${panelClassName}`}>
        <h2
          id={titleId}
          data-app-dialog-heading
          tabIndex={-1}
          className={titleClassName}
        >
          {title}
        </h2>
        {typeof children === "function" ? children(requestDismiss) : children}
      </div>
    </dialog>
  );
}

export function AppDrawer({
  className = "",
  panelClassName = "",
  titleClassName = "sr-only",
  ...props
}: AppDialogProps) {
  return (
    <AppDialog
      {...props}
      presentation="drawer"
      className={className}
      panelClassName={panelClassName}
      titleClassName={titleClassName}
    />
  );
}
