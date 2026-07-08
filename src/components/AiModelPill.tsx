import Link from "next/link";

// GET /api/settings/llm/health response.
export type LlmHealthState =
  | { configured: false }
  | { configured: true; provider: string; ok: boolean; detail: string };

// AI-model connection pill for the home header (mirrors WhisperPill). Icon + text,
// never color alone. Links to /settings when the model is unset or summarizing is
// paused; otherwise a plain badge.
export function AiModelPill({ health, loading }: { health: LlmHealthState | null; loading: boolean }) {
  if (loading || health === null) {
    return <Pill dotClass="bg-inkSoft" textClass="text-inkSoft" label="확인 중" />;
  }
  if (!health.configured) {
    return <Pill href="/settings" dotClass="bg-warn" textClass="text-warn" label="AI 모델 미설정" />;
  }
  if (health.ok) {
    return <Pill dotClass="bg-success" textClass="text-success" label="AI 모델 연결됨" />;
  }
  return (
    <Pill href="/settings" dotClass="bg-error" textClass="text-error" label={`요약 일시중지 — ${health.detail}`} />
  );
}

function Pill({
  href,
  dotClass,
  textClass,
  label,
}: {
  href?: string;
  dotClass: string;
  textClass: string;
  label: string;
}) {
  const base =
    "inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[13px] font-medium";
  const inner = (
    <>
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
      <span className={`max-w-[220px] truncate ${textClass}`} title={label}>
        {label}
      </span>
    </>
  );

  if (href) {
    return (
      <Link href={href} className={`${base} transition-colors hover:bg-soft`} aria-live="polite">
        {inner}
      </Link>
    );
  }
  return (
    <span className={base} aria-live="polite">
      {inner}
    </span>
  );
}
