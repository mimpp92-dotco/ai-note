// whisper connection pill for the home header. Icon + text (never color alone).
// `loading` = still checking; otherwise connected/disconnected drive tone + label.
export function WhisperPill({ connected, loading }: { connected: boolean; loading: boolean }) {
  const { label, dotClass, textClass } = loading
    ? { label: "확인 중", dotClass: "bg-inkSoft", textClass: "text-inkSoft" }
    : connected
      ? { label: "전사 서버 연결됨", dotClass: "bg-success", textClass: "text-success" }
      : { label: "전사 서버 연결 안 됨", dotClass: "bg-error", textClass: "text-error" };

  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[13px] font-medium"
      aria-live="polite"
    >
      <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} aria-hidden="true" />
      <span className={textClass}>{label}</span>
    </span>
  );
}
