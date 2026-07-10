"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { GuardedLink as Link } from "@/components/RecorderNavigation";
import { formatLlmStatus, formatWhisperStatus, type LlmHealthState, type WhisperHealthState } from "@/components/healthStatus";
import { useHealth } from "@/components/useHealth";

// Persistent left app shell (always mounted via layout). Brand + primary nav
// (회의록 관리 / 단어 관리) with settings and local system health. Single-user
// local app — no profile/workspace/search/team/template widgets.

const PRIMARY = [
  {
    href: "/",
    label: "회의록 관리",
    icon: <MeetingsIcon />,
    match: (p: string) => p === "/" || p.startsWith("/meetings"),
  },
  { href: "/glossary", label: "단어 관리", icon: <GlossaryIcon />, match: (p: string) => p.startsWith("/glossary") },
];

export function Sidebar() {
  const pathname = usePathname() ?? "/";
  const { whisper, llm } = useHealth();
  const settingsActive = pathname.startsWith("/settings");

  return (
    <nav
      aria-label="주요 메뉴"
      className="relative flex w-full max-w-[100vw] flex-col overflow-hidden border-b border-line bg-chrome px-4 py-4 md:min-h-screen md:w-60 md:shrink-0 md:overflow-visible md:border-b-0 md:border-r md:px-3 md:py-6"
    >
      <Link href="/" className="block min-w-0 px-3 pr-24 md:pr-3">
        <span className="block truncate text-[15px] font-bold text-ink">AI NOTE</span>
        <span className="mt-0.5 block truncate text-[12px] font-medium text-inkSoft">로컬 회의록</span>
      </Link>

      <div className="mt-4 md:mt-6">
        <SectionLabel>주요 메뉴</SectionLabel>
      </div>

      <ul className="mt-2 flex min-w-0 flex-wrap gap-1 md:block md:space-y-1">
        {PRIMARY.map((item) => {
          const active = item.match(pathname);
          return (
            <li key={item.href} className="min-w-0 flex-1 md:block">
              <NavRow href={item.href} active={active} icon={item.icon}>
                {item.label}
              </NavRow>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 min-w-0 md:mt-auto md:pt-6">
        <SectionLabel>시스템</SectionLabel>
        <div className="mt-2 grid min-w-0 gap-2">
          <SystemRow label="전사" health={whisper} kind="whisper" />
          <SystemRow label="요약" health={llm} kind="llm" />
        </div>
      </div>

      <div className="border-line md:mt-3 md:border-t md:pt-3 max-md:absolute max-md:right-4 max-md:top-4">
        <NavRow href="/settings" active={settingsActive} icon={<SettingsIcon />} compactOnMobile>
          설정
        </NavRow>
      </div>
    </nav>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="px-3 text-[12px] font-semibold text-inkSoft">{children}</p>;
}

function NavRow({
  href,
  active,
  icon,
  compactOnMobile = false,
  children,
}: {
  href: string;
  active: boolean;
  icon: ReactNode;
  compactOnMobile?: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`relative flex h-9 min-w-0 items-center gap-2 rounded-md px-3 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        active ? "bg-soft font-semibold text-ink" : "text-inkSoft hover:bg-panel hover:text-ink"
      } ${compactOnMobile ? "max-md:h-8 max-md:px-2" : ""}`}
    >
      {active && (
        <span
          data-active-marker
          className="absolute left-0 top-1.5 h-6 w-[3px] rounded-r-full bg-accent"
          aria-hidden="true"
        />
      )}
      <span className="shrink-0" aria-hidden="true">
        {icon}
      </span>
      <span className="truncate">{children}</span>
    </Link>
  );
}

function SystemRow({
  label,
  health,
  kind,
}: {
  label: string;
  health: WhisperHealthState | LlmHealthState | null;
  kind: "whisper" | "llm";
}) {
  const status = kind === "whisper" ? formatWhisperStatus(health as WhisperHealthState | null) : formatLlmStatus(health as LlmHealthState | null);
  const needsSettings = kind === "llm" && health !== null && (!(health as LlmHealthState).configured || ((health as LlmHealthState).configured && !(health as Extract<LlmHealthState, { configured: true }>).ok));
  const inner = (
    <>
      <span className="w-8 shrink-0 text-[12px] font-semibold text-inkSoft">{label}</span>
      <span className={`h-2 w-2 shrink-0 rounded-full ${status.dotClass}`} aria-hidden="true" />
      <span className={`min-w-0 truncate text-[12px] font-medium ${status.textClass}`} title={status.title}>
        {status.label}
      </span>
    </>
  );
  const cls =
    "flex h-9 min-w-0 items-center gap-2 rounded-md border border-line/70 bg-panel/55 px-3 text-left transition-colors";

  if (needsSettings) {
    return (
      <Link href="/settings" className={`${cls} hover:bg-panel`} title={status.title} aria-live="polite">
        {inner}
      </Link>
    );
  }
  return (
    <div className={cls} title={status.title} aria-live="polite">
      {inner}
    </div>
  );
}

function IconBase({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4" aria-hidden="true">
      {children}
    </svg>
  );
}

function MeetingsIcon() {
  return (
    <IconBase>
      <path d="M5 5.5h14" strokeLinecap="round" />
      <path d="M5 12h14" strokeLinecap="round" />
      <path d="M5 18.5h9" strokeLinecap="round" />
    </IconBase>
  );
}

function GlossaryIcon() {
  return (
    <IconBase>
      <path d="M6 4.75h8.5A3.5 3.5 0 0 1 18 8.25v11H8.5A2.5 2.5 0 0 1 6 16.75v-12Z" />
      <path d="M9 8h5" strokeLinecap="round" />
      <path d="M9 11.5h4" strokeLinecap="round" />
    </IconBase>
  );
}

function SettingsIcon() {
  return (
    <IconBase>
      <path d="M12 8.75A3.25 3.25 0 1 0 12 15.25 3.25 3.25 0 0 0 12 8.75Z" />
      <path
        d="M19 12a7 7 0 0 0-.07-.97l1.72-1.34-1.7-2.94-2.04.82a7.05 7.05 0 0 0-1.68-.98L14.93 4h-3.86l-.3 2.59c-.6.24-1.16.57-1.68.98l-2.04-.82-1.7 2.94 1.72 1.34a7.24 7.24 0 0 0 0 1.94l-1.72 1.34 1.7 2.94 2.04-.82c.52.41 1.08.74 1.68.98l.3 2.59h3.86l.3-2.59c.6-.24 1.16-.57 1.68-.98l2.04.82 1.7-2.94-1.72-1.34c.05-.32.07-.64.07-.97Z"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}
