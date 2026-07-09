import { formatWhisperStatus, type WhisperHealthState } from "@/components/healthStatus";

// Whisper connection pill for compact surfaces. Icon + text (never color alone).
export function WhisperPill({ health, loading }: { health: WhisperHealthState | null; loading?: boolean }) {
  const { label, dotClass, textClass, title } = formatWhisperStatus(loading ? null : health);

  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[13px] font-medium"
      aria-live="polite"
      title={title}
    >
      <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} aria-hidden="true" />
      <span className={textClass}>{label}</span>
    </span>
  );
}
