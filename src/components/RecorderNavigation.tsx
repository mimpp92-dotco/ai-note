"use client";

import Link, { type LinkProps } from "next/link";
import { useRouter } from "next/navigation";
import {
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useCallback,
} from "react";

import {
  useOptionalRecorderSession,
  useRecorderSession,
} from "@/components/RecorderSessionProvider";

type GuardedLinkProps = LinkProps
  & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps | "href">
  & { children: ReactNode; onNavigationCommitted?: () => void };

function plainPrimaryClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey
    && event.currentTarget.target !== "_blank";
}

export function GuardedLink({
  href,
  children,
  onClick,
  onNavigationCommitted,
  ...props
}: GuardedLinkProps) {
  const router = useRouter();
  const session = useOptionalRecorderSession();
  const destination = typeof href === "string" ? href : href.pathname ?? "/";
  return (
    <Link
      href={href}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !plainPrimaryClick(event)) return;
        if (!session) return;
        event.preventDefault();
        session.requestNavigation(
          destination,
          () => {
            onNavigationCommitted?.();
            router.push(destination);
          },
          event.currentTarget,
        );
      }}
    >
      {children}
    </Link>
  );
}

export function useGuardedRouter() {
  const router = useRouter();
  const session = useRecorderSession();
  return {
    push: useCallback((href: string, trigger?: HTMLElement | null) => {
      session.requestNavigation(href, () => router.push(href), trigger);
    }, [router, session]),
    replace: useCallback((href: string, trigger?: HTMLElement | null) => {
      session.requestNavigation(href, () => router.replace(href), trigger);
    }, [router, session]),
    back: useCallback((trigger?: HTMLElement | null) => {
      session.requestNavigation("history:back", () => router.back(), trigger);
    }, [router, session]),
    refresh: router.refresh,
  };
}
