"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { AiModelPill } from "@/components/AiModelPill";
import { useHealth } from "@/components/useHealth";
import { WhisperPill } from "@/components/WhisperPill";

// Persistent left app shell (always mounted via layout). Brand + primary nav
// (회의록 관리 / 단어 관리) with a settings anchor and the whisper/AI health pills
// at the bottom. Single-user local app — no profile/workspace/usage widgets.

const PRIMARY = [
  { href: "/", label: "회의록 관리", match: (p: string) => p === "/" || p.startsWith("/meetings") },
  { href: "/glossary", label: "단어 관리", match: (p: string) => p.startsWith("/glossary") },
];

export function Sidebar() {
  const pathname = usePathname() ?? "/";
  const { whisper, llm } = useHealth();
  const settingsActive = pathname.startsWith("/settings");

  return (
    <nav
      aria-label="주요 메뉴"
      className="flex w-60 shrink-0 flex-col border-r border-line bg-chrome px-3 py-6"
    >
      <Link href="/" className="px-3 text-[15px] font-bold tracking-tight text-ink">
        AI NOTE
      </Link>

      <ul className="mt-6 space-y-1">
        {PRIMARY.map((item) => {
          const active = item.match(pathname);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`block rounded-lg px-3 py-2 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  active ? "bg-soft text-ink" : "text-inkSoft hover:text-ink"
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto space-y-3 pt-6">
        <div className="flex flex-col items-start gap-2 px-1">
          <WhisperPill connected={whisper?.connected ?? false} loading={whisper === null} />
          <AiModelPill health={llm} loading={llm === null} />
        </div>
        <div className="border-t border-line pt-3">
          <Link
            href="/settings"
            aria-current={settingsActive ? "page" : undefined}
            className={`block rounded-lg px-3 py-2 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              settingsActive ? "bg-soft text-ink" : "text-inkSoft hover:text-ink"
            }`}
          >
            설정
          </Link>
        </div>
      </div>
    </nav>
  );
}
