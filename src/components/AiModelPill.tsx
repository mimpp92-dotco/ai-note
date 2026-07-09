import Link from "next/link";

import { formatLlmStatus, type LlmHealthState } from "@/components/healthStatus";

// AI-model connection pill for the home header (mirrors WhisperPill). Icon + text,
// never color alone. Links to /settings when the model is unset or summarizing is
// paused; otherwise a plain badge.
export function AiModelPill({ health, loading }: { health: LlmHealthState | null; loading: boolean }) {
  const status = formatLlmStatus(loading ? null : health);
  const needsSettings = health !== null && (!health.configured || (health.configured && !health.ok));
  return <Pill href={needsSettings ? "/settings" : undefined} {...status} />;
}

function Pill({
  href,
  dotClass,
  textClass,
  label,
  title,
}: {
  href?: string;
  dotClass: string;
  textClass: string;
  label: string;
  title: string;
}) {
  const base =
    "inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[13px] font-medium";
  const inner = (
    <>
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
      <span className={`max-w-[220px] truncate ${textClass}`} title={title}>
        {label}
      </span>
    </>
  );

  if (href) {
    return (
      <Link href={href} className={`${base} transition-colors hover:bg-soft`} aria-live="polite" title={title}>
        {inner}
      </Link>
    );
  }
  return (
    <span className={base} aria-live="polite" title={title}>
      {inner}
    </span>
  );
}
