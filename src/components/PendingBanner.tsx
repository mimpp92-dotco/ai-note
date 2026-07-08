import { CopyButton } from "@/components/CopyButton";

const SUMMARIZE_CMD = "/meeting-summarize latest";

// Shown on home when ≥1 meeting is transcribed but not yet summarized: the user
// must run /meeting-summarize in the terminal (the app never calls an LLM). Renders
// nothing when count is 0.
export function PendingBanner({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div className="flex items-center justify-between gap-4 rounded-[14px] border border-warn/40 bg-warnBg px-5 py-4">
      <p className="text-[14px] text-ink">
        <span className="font-semibold">{count}개 회의 교정 대기</span> — 터미널에서{" "}
        <code className="rounded bg-panel px-1.5 py-0.5 font-mono text-[13px] text-accent">
          /meeting-summarize
        </code>{" "}
        실행
      </p>
      <CopyButton text={SUMMARIZE_CMD} label="커맨드 복사" />
    </div>
  );
}
