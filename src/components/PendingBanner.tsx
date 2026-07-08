import Link from "next/link";

// Home backlog banner for meetings transcribed but not yet summarized. The app
// summarizes in-process once a model is set, so the message depends on config:
// no model → onboarding prompt with a link to settings; model set → auto-processing.
// Renders nothing when count is 0. `configured` is null while health is loading.
export function PendingBanner({ count, configured }: { count: number; configured: boolean | null }) {
  if (count <= 0) return null;

  if (configured === false) {
    return (
      <div className="rounded-[14px] border border-warn/40 bg-warnBg px-5 py-4">
        <div className="flex items-center justify-between gap-4">
          <p className="text-[14px] text-ink">
            <span className="font-semibold">{count}개 회의가 요약 대기 중</span> — 모델을 설정하면 자동 생성됩니다.
          </p>
          <Link
            href="/settings"
            className="shrink-0 rounded-md border border-line bg-panel px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:bg-soft"
          >
            설정
          </Link>
        </div>
        <p className="mt-1.5 text-[13px] text-inkSoft">
          녹음·전사는 모델 없이 동작합니다. 요약만 모델이 필요합니다.
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-[14px] border border-line bg-panel px-5 py-4">
      <span
        className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
        aria-hidden="true"
      />
      <p className="text-[14px] text-ink">
        <span className="font-semibold">{count}개 회의</span> 요약 자동 처리 중…
      </p>
    </div>
  );
}
