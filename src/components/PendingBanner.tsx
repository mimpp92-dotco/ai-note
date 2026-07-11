import { GuardedLink as Link } from "@/components/RecorderNavigation";
import type { LlmReadiness } from "@/components/healthStatus";

// Home backlog banner for meetings transcribed but not yet summarized. The app
// summarizes in-process only when the configured model is currently usable.
// `count` = meetings the worker will auto-process; `needsAttention` = meetings
// whose auto-summary already failed (worker backed off) — showing those as
// "자동 처리 중" would be a false-green promise, so they get "확인 필요" instead.
export function PendingBanner({
  count,
  needsAttention = 0,
  readiness,
  attention = null,
}: {
  count: number;
  needsAttention?: number;
  readiness: LlmReadiness;
  attention?: { meetingId: string; cursor: string } | null;
}) {
  if (count <= 0 && needsAttention <= 0) return null;

  if (readiness === "ready") {
    const processing = count > 0;
    return (
      <div className="flex flex-col items-stretch gap-3 rounded-[14px] border border-line bg-panel p-4 sm:flex-row sm:items-center sm:px-6">
        <div className="flex min-w-0 items-start gap-2 sm:items-center">
          {processing && (
            <span
              className="mt-1.5 inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none sm:mt-0"
              aria-hidden="true"
            />
          )}
          <p className="min-w-0 break-words text-[14px] text-ink">
            {processing && (
              <>
                <span className="font-semibold">{count}개 회의</span> 요약 자동 처리 중…
              </>
            )}
            {processing && needsAttention > 0 && " · "}
            {needsAttention > 0 && (
              <span className="font-semibold text-warn">{needsAttention}개 확인 필요</span>
            )}
          </p>
        </div>
        {needsAttention > 0 && attention && (
          <Link
            href={`/meetings/${attention.meetingId}?attentionAfter=${encodeURIComponent(attention.cursor)}`}
            className="inline-flex min-h-11 w-full shrink-0 items-center justify-center rounded-lg border border-line bg-panel px-3 text-[13px] font-medium text-accent transition-colors hover:bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:ml-auto sm:w-auto"
          >
            확인할 회의 열기
          </Link>
        )}
      </div>
    );
  }

  const total = count + needsAttention;
  const unavailable = readiness === "unavailable";
  return (
    <div className={`rounded-[14px] border p-4 sm:px-6 ${unavailable ? "border-error/40 bg-error/5" : "border-warn/40 bg-warnBg"}`}>
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 break-words text-[14px] text-ink">
          <span className="font-semibold">{total}개 회의가 요약 대기 중</span> —{" "}
          {unavailable ? "요약 모델을 확인하세요." : "모델을 설정하면 자동 생성됩니다."}
        </p>
        <Link
          href="/settings"
          className="inline-flex min-h-11 w-full shrink-0 items-center justify-center rounded-lg border border-line bg-panel px-3 text-[13px] font-medium text-accent transition-colors hover:bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:w-auto"
        >
          설정
        </Link>
      </div>
      <p className="mt-1.5 text-[13px] text-inkSoft">
        {unavailable
          ? "설정한 모델이 지금 사용할 수 없습니다. 설정에서 연결 상태를 확인하세요."
          : readiness === "loading"
            ? "요약 모델 상태를 확인하고 있습니다."
            : "녹음·전사는 모델 없이 동작합니다. 요약만 모델이 필요합니다."}
      </p>
    </div>
  );
}
