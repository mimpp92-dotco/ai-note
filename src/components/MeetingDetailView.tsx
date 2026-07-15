"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { CopyButton } from "@/components/CopyButton";
import { LibraryLocationPicker } from "@/components/LibraryLocationPicker";
import { useOptionalLibrary } from "@/components/LibraryProvider";
import { GuardedLink as Link } from "@/components/RecorderNavigation";
import { useOptionalRecorderSession } from "@/components/RecorderSessionProvider";
import { Tabs, type TabItem } from "@/components/Tabs";
import { type LlmReadiness, getLlmReadiness } from "@/components/healthStatus";
import { useHealth } from "@/components/useHealth";
import type {
  ErrorAction,
  MeetingStatus,
  ReviewInput,
} from "@/domain/meeting";
import type { Summary } from "@/domain/summary";
import { resolvePostMoveDetailSource } from "@/lib/detailSource";
import { formatLocationBreadcrumb } from "@/lib/libraryClient";
import type { LibraryMeetingScope } from "@/lib/libraryQuery";
import { formatMeetingDate, STATUS_LABELS } from "@/lib/meetingLabels";
import { formatDuration } from "@/lib/recorder";
import { formatSummaryMarkdown } from "@/lib/summaryMarkdown";

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface MeetingDetailStatus {
  id: string;
  title: string;
  status: MeetingStatus;
  error: { message: string; action: ErrorAction } | null;
  startedAt: string;
  review: ReviewInput;
}

export interface MeetingDetailData {
  id: string;
  status: MeetingDetailStatus;
  transcript: { text: string; corrected: boolean };
  segments: Segment[];
  summary: Summary | null;
  hasAudio: boolean;
  // True while a summarize holds the in-flight lock for this meeting (server-derived
  // from isSummarizeInflight). The manual re-summarize poll uses it to detect
  // completion even when the summary content is unchanged. Optional/defaults false.
  resummarizeInflight?: boolean;
  backHref?: string;
  location?: { workspaceId: string; folderId: string | null } | null;
  source?: Exclude<LibraryMeetingScope, { kind: "global" }>;
  sourceAccepted?: boolean;
  canonicalDetailHref?: string;
  attentionAfter?: string | null;
}

// The server may run up to three sequential LLM calls per (re)summarize — correction,
// summary, and an optional fallback summary — each capped at 30 min
// (LLM_GENERATION_TIMEOUT_MS in src/services/llm/exec.ts, kept in sync by this
// derivation). Poll past that worst case before declaring a timeout so a slow
// long-meeting re-summarize (the exact case the 30 min cap exists for) isn't falsely
// reported as failed. Not imported from exec.ts: that module pulls in node:child_process.
const RESUMMARIZE_TIMEOUT_MS = 3 * 1_800_000 + 30_000; // ~90.5 min

const ACTION_CONTROL_CLASS =
  "inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-line bg-panel px-3 py-2 text-[13px] font-medium text-accent transition-colors hover:bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50";

function Section({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      {title && <h3 className="text-[14px] font-bold text-ink">{title}</h3>}
      <ul className="mt-2 space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2 text-[14px] leading-relaxed text-inkSoft">
            <span aria-hidden="true" className="text-inkSoft">
              •
            </span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MeetingDetailView({
  id,
  status,
  transcript,
  segments,
  summary,
  hasAudio,
  resummarizeInflight = false,
  backHref = "/",
  location = null,
  source,
  sourceAccepted = true,
  canonicalDetailHref,
  attentionAfter = null,
}: MeetingDetailData) {
  const router = useRouter();
  const recorderSession = useOptionalRecorderSession();
  const [tab, setTab] = useState<"script" | "summary">("script");
  const [resummarizing, setResummarizing] = useState(false);
  const [resummarizeError, setResummarizeError] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTrigger, setMoveTrigger] = useState<HTMLElement | null>(null);
  const [currentLocation, setCurrentLocation] = useState(location);
  const [currentSource, setCurrentSource] = useState(source);
  const [currentBackHref, setCurrentBackHref] = useState(backHref);
  const [moveMessage, setMoveMessage] = useState<string | null>(null);
  const [resummarizeConfirming, setResummarizeConfirming] = useState(false);
  const [currentParticipants, setCurrentParticipants] = useState(() => [...status.review.participants]);
  const observedParticipantsSignature = useRef(JSON.stringify(status.review.participants));

  // Shared health hook lets transcribed meetings distinguish ready, missing, and
  // unavailable summarizers before promising automatic processing.
  const { llm } = useHealth();
  const library = useOptionalLibrary();
  const refreshSummaryWork = library?.refreshSummaryWork;
  const readiness = getLlmReadiness(llm);
  const observedGenerationEpochRef = useRef(library?.generationEpoch ?? 0);

  useEffect(() => {
    setCurrentLocation(location);
    setCurrentSource(source);
    setCurrentBackHref(backHref);
  }, [backHref, location, source]);

  const incomingParticipantsSignature = JSON.stringify(status.review.participants);
  useEffect(() => {
    if (observedParticipantsSignature.current === incomingParticipantsSignature) return;
    observedParticipantsSignature.current = incomingParticipantsSignature;
    setCurrentParticipants([...status.review.participants]);
  }, [incomingParticipantsSignature, status.review.participants]);

  useEffect(() => {
    if (sourceAccepted || !canonicalDetailHref) return;
    router.replace(canonicalDetailHref);
  }, [canonicalDetailHref, router, sourceAccepted]);

  useEffect(() => {
    const generationEpoch = library?.generationEpoch ?? 0;
    if (observedGenerationEpochRef.current === generationEpoch) return;
    observedGenerationEpochRef.current = generationEpoch;
    setMoveOpen(false);
    setMoveTrigger(null);
    setMoveMessage(null);
    // A rebuild creates a new placement generation. Refresh the RSC so the
    // meeting's effective location and source-safe back link are resolved from
    // the new registry instead of retaining stale workspace/folder IDs.
    router.refresh();
  }, [library?.generationEpoch, router]);

  useEffect(() => {
    if (attentionAfter) refreshSummaryWork?.(attentionAfter);
  }, [attentionAfter, refreshSummaryWork]);

  // A (re)summarize is async: the route returns 202 and the work runs in the
  // background under an in-flight lock. `resummarizeInflight` is that lock, derived by
  // the server (isSummarizeInflight) — the single source of truth for "a run is
  // happening on this meeting", whether this tab started it or another entry did.
  // `resummarizing` is a local optimistic flag that covers the window between the
  // button click and the first poll observing the lock. The UI shows progress and
  // gates the buttons on EITHER, so opening the page mid-run correctly reads as busy
  // (deriveStatus otherwise masks the transient state as summarized).
  const inProgress = resummarizing || resummarizeInflight;
  const baseSummarySig = useRef<string | null>(null);
  const seenInflight = useRef(false);
  const deadline = useRef(0);
  const wasInProgress = useRef(false);
  const resummarizePanelWasBusy = useRef(false);

  useEffect(() => {
    if (inProgress) {
      resummarizePanelWasBusy.current = true;
      return;
    }
    if (!resummarizePanelWasBusy.current) return;
    resummarizePanelWasBusy.current = false;
    if (!resummarizeError) setResummarizeConfirming(false);
  }, [inProgress, resummarizeError]);

  // Capture a baseline once each time a run begins — from a local click or from
  // entering the page while a run is already in flight. Runs before the completion
  // effect (declared first) so its comparisons use this baseline.
  useEffect(() => {
    if (inProgress && !wasInProgress.current) {
      baseSummarySig.current = summary ? JSON.stringify(summary) : null;
      seenInflight.current = resummarizeInflight; // already in flight on entry ⇒ observed
      deadline.current = Date.now() + RESUMMARIZE_TIMEOUT_MS;
      setResummarizeError(null);
    }
    wasInProgress.current = inProgress;
  }, [inProgress, summary, resummarizeInflight]);

  // Poll for fresh server data while a run is in flight (manual or worker-driven). The
  // ceiling only applies to a locally-started run — a run observed via the server lock
  // is trusted to clear itself (each LLM call is capped, so the lock can't hang).
  useEffect(() => {
    const active = inProgress || status.status === "summarizing";
    if (!active) return;
    const timer = setInterval(() => {
      if (resummarizing && Date.now() > deadline.current) {
        setResummarizing(false);
        setResummarizeError("재요약이 시간 내에 끝나지 않았어요. 잠시 후 다시 시도하세요.");
        return;
      }
      router.refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [inProgress, status.status, resummarizing, router]);

  // Detect completion of a run from refreshed server props.
  useEffect(() => {
    if (!inProgress) return;

    // (a) New summary content is an unambiguous success, independent of the lock — the
    // baseline was captured at begin, so a change means fresh data has arrived.
    const sig = summary ? JSON.stringify(summary) : null;
    if (sig !== baseSummarySig.current) {
      setResummarizing(false);
      setResummarizeError(null);
      return;
    }

    // (b) The server still reports the run in flight → keep waiting, and remember we
    // saw it hold the lock (so its later release is trustworthy).
    if (resummarizeInflight) {
      seenInflight.current = true;
      return;
    }

    // Lock is clear. Only trust the terminal state once we've actually observed the run
    // in flight — otherwise stale props from before the run started (an old
    // retry_summary error, or the pre-run unlocked state) would read as instant done.
    if (!seenInflight.current) return;
    setResummarizing(false);
    // A retry_summary error means it failed (StatusCard shows the banner); otherwise
    // the lock released cleanly → success even if the regenerated content is identical.
    if (status.error?.action !== "retry_summary") setResummarizeError(null);
  }, [inProgress, resummarizeInflight, summary, status]);

  const beginResummarize = async (force: boolean) => {
    if (inProgress) return;
    setResummarizeError(null);
    setResummarizing(true); // optimistic; the entry effect captures the baseline
    try {
      const res = await fetch(`/api/meetings/${id}/summarize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resummarize: force }),
      });
      // 202 → accepted; the polling effects above take over. Anything else is a
      // synchronous refusal (409 in-flight/already, 400 no-model, 404) we surface now.
      if (!res.ok) {
        setResummarizing(false);
        setResummarizeError(
          res.status === 409
            ? "요약 중에는 다시 요약할 수 없어요. 잠시 후 다시 시도하세요."
            : "다시 요약에 실패했어요. 잠시 후 다시 시도하세요.",
        );
      }
    } catch {
      setResummarizing(false);
      setResummarizeError("다시 요약에 실패했어요. 잠시 후 다시 시도하세요.");
    }
  };

  const canMove = library?.mode === "ready" && Boolean(library.version && library.library);
  const hasSummaryActions = status.status === "summarized" && summary !== null;
  const hasAttentionNotice = Boolean(attentionAfter && library?.summaryWork);
  const hasLifecycleNotice = inProgress
    || status.error?.action === "retry_summary"
    || status.status === "summarizing"
    || status.status === "transcribed";
  const hasNotices = Boolean(moveMessage || hasAttentionNotice || hasLifecycleNotice);
  const detailTabs: TabItem<"script" | "summary">[] = [
    {
      value: "script" as const,
      label: "전체 스크립트",
      content: <ScriptTab transcript={transcript} segments={segments} />,
    },
    {
      value: "summary" as const,
      label: "회의록 요약",
      content: <SummaryTab summary={summary} />,
    },
  ];

  return (
    <main id="main" className="max-w-5xl space-y-8 px-4 py-12 sm:px-6">
      <header data-detail-section="heading">
        <Link href={currentBackHref} className="inline-flex min-h-11 items-center text-[13px] text-inkSoft hover:text-accent">
          ← 목록
        </Link>
        <div className="mt-3 min-w-0">
          <h1 className="break-words text-2xl font-bold tracking-tight text-ink">{status.title}</h1>
        </div>
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-inkSoft">
          <span className="font-mono text-[12px]">{formatMeetingDate(status.startedAt)}</span>
          <span className="rounded-full bg-soft px-3 py-1 text-[12px] font-medium text-inkSoft">
            {STATUS_LABELS[inProgress ? "summarizing" : status.status]}
          </span>
        {currentLocation && library?.library && (
          <span className="min-w-0 break-words">
            위치: {formatLocationBreadcrumb(
              library.library,
              currentLocation.workspaceId,
              currentLocation.folderId,
            ).join(" / ")}
          </span>
        )}
        </div>
      </header>

      <div data-detail-section="notices" className={hasNotices ? "space-y-3" : "hidden"}>
        {moveMessage && (
          <p role="status" aria-live="polite" className="rounded-[12px] border border-success/30 bg-successBg px-4 py-3 text-[13px] text-success">
            {moveMessage}
          </p>
        )}
        {attentionAfter && library?.summaryWork && (
          <div className="flex flex-col items-start gap-2 rounded-[12px] border border-line bg-panel px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center">
            {library.summaryWork.summaryWork.attention ? (
              <Link
                href={`/meetings/${library.summaryWork.summaryWork.attention.meetingId}?attentionAfter=${encodeURIComponent(library.summaryWork.summaryWork.attention.cursor)}`}
                className={ACTION_CONTROL_CLASS}
              >
                다음 확인 필요 회의
              </Link>
            ) : library.summaryWork.summaryWork.needsAttention > 0 ? (
              <button
                type="button"
                onClick={() => library.refreshSummaryWork(null)}
                className={ACTION_CONTROL_CLASS}
              >
                처음부터 다시 확인
              </button>
            ) : (
              <span className="text-[13px] text-success">확인할 회의를 모두 살펴봤습니다.</span>
            )}
          </div>
        )}
        <StatusCard
          status={status}
          readiness={readiness}
          inProgress={inProgress}
          onRetry={() => void beginResummarize(summary != null)}
          retrying={inProgress}
        />
      </div>

      <div data-detail-section="actions" className={(canMove || hasSummaryActions) ? "space-y-3" : "hidden"}>
        <div role="group" aria-label="회의 작업" className="flex flex-wrap items-center gap-2">
          {canMove && (
            <button
              type="button"
              onClick={(event) => {
                setMoveTrigger(event.currentTarget);
                setMoveOpen(true);
                setMoveMessage(null);
              }}
              className={ACTION_CONTROL_CLASS}
            >
              회의 이동
            </button>
          )}
          {hasSummaryActions && summary && (
            <>
              <ExportToolbar
                id={id}
                summary={summary}
                transcript={transcript.text}
                participants={currentParticipants}
              />
              {!resummarizeConfirming && (
                <button
                  type="button"
                  disabled={inProgress}
                  onClick={() => setResummarizeConfirming(true)}
                  className={ACTION_CONTROL_CLASS}
                >
                  {inProgress ? "요약 중…" : "다시 요약"}
                </button>
              )}
            </>
          )}
        </div>
        {hasSummaryActions && resummarizeConfirming && (
          <ResummarizePanel
            busy={inProgress}
            error={resummarizeError}
            onRun={() => void beginResummarize(true)}
            onCancel={() => setResummarizeConfirming(false)}
          />
        )}
        {moveOpen && (
          <LibraryLocationPicker
            kind="meeting"
            meetingId={id}
            current={currentLocation}
            trigger={moveTrigger}
            onClose={() => setMoveOpen(false)}
            onMoved={(actual) => {
              const fallbackSource = currentSource ?? (actual.folderId === null
                ? { kind: "unfiled" as const, workspaceId: actual.workspaceId }
                : { kind: "folder" as const, workspaceId: actual.workspaceId, folderId: actual.folderId });
              const next = resolvePostMoveDetailSource({
                meetingId: id,
                source: fallbackSource,
                actual,
                attentionAfter,
              });
              setCurrentLocation(actual);
              setCurrentSource(next.source);
              setCurrentBackHref(next.backHref);
              setMoveMessage(next.sourceChanged
                ? "회의를 이동해 목록 기준도 실제 저장 위치로 바꿨습니다."
                : "회의를 이동했습니다. 현재 목록에서도 계속 볼 수 있습니다.");
              const commit = () => router.replace(next.detailHref);
              if (recorderSession) recorderSession.requestNavigation(next.detailHref, commit);
              else commit();
            }}
          />
        )}
      </div>

      <section
        data-detail-section="meeting-info"
        aria-labelledby={`meeting-info-${id}`}
        className="space-y-3"
      >
        <h2 id={`meeting-info-${id}`} className="text-[16px] font-bold text-ink">회의 정보</h2>
        <div className={hasAudio ? "grid gap-4 lg:grid-cols-2 lg:items-start" : "max-w-2xl"}>
          {hasAudio && (
            <div className="rounded-[16px] border border-line bg-panel p-4 sm:p-5">
              <h3 className="text-[14px] font-bold text-ink">녹음 재생</h3>
              <audio controls preload="metadata" src={`/api/meetings/${id}/audio`} className="mt-3 w-full" />
            </div>
          )}
          <ReviewForm
            id={id}
            participants={currentParticipants}
            onSaved={(next) => setCurrentParticipants([...next])}
          />
        </div>
      </section>

      <section data-detail-section="tabs" aria-label="회의 내용">
        <Tabs<"script" | "summary">
          id={`meeting-${id}-content`}
          ariaLabel="회의 내용"
          items={detailTabs}
          value={tab}
          onValueChange={setTab}
        />
      </section>
    </main>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent motion-reduce:animate-none"
      aria-hidden="true"
    />
  );
}

// The toolbar owns the trigger while this panel owns only confirmation. Keeping the
// panel outside the action group preserves sibling rhythm and leaves synchronous
// errors visible; busy disables both confirm and cancel.
function ResummarizePanel({
  onRun,
  onCancel,
  busy,
  error,
}: {
  onRun: () => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-[12px] border border-line bg-soft px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center">
      <p className="min-w-0 text-[13px] text-ink">현재 요약을 새로 생성합니다(단어장 변경 반영).</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onRun}
          disabled={busy}
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-ink px-4 py-2 text-[13px] font-semibold text-bg transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {busy ? "요약 중…" : "다시 요약"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className={ACTION_CONTROL_CLASS}
        >
          취소
        </button>
      </div>
      {error && (
        <span role="status" aria-live="polite" className="basis-full text-[13px] text-error">
          {error}
        </span>
      )}
    </div>
  );
}

// Lifecycle card above the tabs: surfaces a summarize failure (with retry), the
// in-progress spinner, or the transcribed→summary hint. null once summarized.
function StatusCard({
  status,
  readiness,
  inProgress,
  onRetry,
  retrying,
}: {
  status: MeetingDetailStatus;
  readiness: LlmReadiness;
  inProgress: boolean;
  onRetry: () => void;
  retrying: boolean;
}) {
  // A run in flight wins over everything: while summarizing/re-summarizing, show the
  // spinner (not a stale error banner, and not the "summarized" resting state that
  // deriveStatus reports when a prior summary.json still exists).
  if (inProgress) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-line bg-panel px-4 py-4 sm:px-5">
        <Spinner />
        <p className="text-[14px] text-ink">요약 생성 중…</p>
      </div>
    );
  }

  if (status.error?.action === "retry_summary") {
    // A re-summarize failure keeps `summarized` (the prior summary survives); a
    // first-time failure sits at `transcribed`. Word the banner to match.
    const label = status.status === "summarized" ? "재요약 실패" : "요약 실패";
    return (
      <div className="flex flex-col items-start gap-3 rounded-[12px] border border-error/40 bg-error/10 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <p className="min-w-0 break-words text-[14px] text-ink">
          <span className="font-semibold text-error">{label}</span> — {status.error.message}
        </p>
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md bg-ink px-5 py-2 text-[14px] font-semibold text-bg transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {retrying ? "재시도 중…" : "재시도"}
        </button>
      </div>
    );
  }

  if (status.status === "summarizing") {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-line bg-panel px-4 py-4 sm:px-5">
        <Spinner />
        <p className="text-[14px] text-ink">요약 생성 중…</p>
      </div>
    );
  }

  if (status.status === "transcribed") {
    if (readiness === "unconfigured" || readiness === "unavailable") {
      const unavailable = readiness === "unavailable";
      return (
        <div
          className={`flex flex-col items-start gap-3 rounded-[12px] border px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5 ${
            unavailable ? "border-error/40 bg-error/5" : "border-warn/40 bg-warnBg"
          }`}
        >
          <p className="text-[14px] text-ink">
            {unavailable ? "요약 모델을 확인하세요. 설정한 모델이 지금 사용할 수 없습니다." : "요약하려면 모델을 설정하세요."}
          </p>
          <Link
            href="/settings"
            className={ACTION_CONTROL_CLASS}
          >
            설정
          </Link>
        </div>
      );
    }
    if (readiness === "loading") {
      return (
        <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-line bg-panel px-4 py-4 sm:px-5">
          <Spinner />
          <p className="text-[14px] text-ink">요약 모델 확인 중…</p>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-line bg-panel px-4 py-4 sm:px-5">
        <span
          className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
          aria-hidden="true"
        />
        <p className="text-[14px] text-ink">요약 대기 · 자동 생성 중…</p>
      </div>
    );
  }

  return null;
}

// Export/copy actions for a finished summary. Copies reuse the already-loaded
// summary/transcript; downloads are plain anchors; 폴더 열기 opens the local folder.
function ExportToolbar({
  id,
  summary,
  transcript,
  participants,
}: {
  id: string;
  summary: Summary;
  transcript: string;
  participants: string[];
}) {
  return (
    <>
      <CopyButton text={formatSummaryMarkdown(summary, participants)} label="요약 복사" />
      <CopyButton text={transcript} label="전사 복사" />
      <a href={`/api/meetings/${id}/export?fmt=md`} download className={ACTION_CONTROL_CLASS}>
        요약 다운로드(.md)
      </a>
      <a href={`/api/meetings/${id}/export?fmt=json`} download className={ACTION_CONTROL_CLASS}>
        JSON(.json)
      </a>
      <RevealButton id={id} />
    </>
  );
}

function RevealButton({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "pending" | "requested" | "error">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const showResult = (next: "requested" | "error") => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setState(next);
    resetTimer.current = setTimeout(() => {
      resetTimer.current = null;
      setState("idle");
    }, next === "error" ? 3000 : 1500);
  };

  const open = async () => {
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
    setState("pending");
    try {
      const response = await fetch(`/api/meetings/${id}/reveal`, { method: "POST" });
      if (!response.ok) throw new Error("reveal request refused");
      // The route accepted the detached OS-viewer request; it cannot synchronously
      // guarantee what the external viewer does afterward.
      showResult("requested");
    } catch {
      showResult("error");
    }
  };

  const label = state === "pending"
    ? "여는 중…"
    : state === "requested"
      ? "열기 요청됨"
      : state === "error"
        ? "열기 실패"
        : "폴더 열기";

  return (
    <button
      type="button"
      onClick={() => void open()}
      disabled={state === "pending"}
      className={ACTION_CONTROL_CLASS}
    >
      <span aria-live="polite" aria-atomic="true">{label}</span>
    </button>
  );
}

function ScriptTab({ transcript, segments }: { transcript: MeetingDetailData["transcript"]; segments: Segment[] }) {
  if (!transcript.text.trim()) {
    return <p className="text-[14px] text-inkSoft">아직 전사가 없습니다.</p>;
  }

  const showSegments = !transcript.corrected && segments.length > 0;

  return (
    <div className="space-y-4">
      {!transcript.corrected && (
        <p className="rounded-md bg-warnBg px-3 py-2 text-[13px] text-warn">교정 전 원문 · 자동 전사</p>
      )}
      {showSegments ? (
        <ul className="space-y-2">
          {segments.map((seg, i) => (
            <li key={i} className="flex gap-3 text-[14px] leading-relaxed">
              <span className="shrink-0 font-mono text-[12px] text-inkSoft">
                {formatDuration(seg.start * 1000)}
              </span>
              <span className="text-ink">{seg.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-3">
          {transcript.text
            .split(/\n{2,}/)
            .flatMap((block) => block.split("\n"))
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line, i) => (
              <p key={i} className="text-[14px] leading-relaxed text-ink">
                {line}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}

function SummaryTab({ summary }: { summary: Summary | null }) {
  if (!summary) {
    return <p className="text-[14px] text-inkSoft">아직 요약이 없습니다.</p>;
  }

  const actionLines = summary.actionItems.map((a) => `${a.owner} — ${a.task} (기한: ${a.due})`);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-[14px] font-bold text-ink">요약</h3>
        <p className="mt-2 text-[15px] leading-relaxed text-ink">{summary.oneLine}</p>
        <Section title="" items={summary.highlights} />
      </div>
      {summary.purpose && (
        <div>
          <h3 className="text-[14px] font-bold text-ink">목적</h3>
          <p className="mt-2 text-[14px] leading-relaxed text-inkSoft">{summary.purpose}</p>
        </div>
      )}
      <Section title="논의 내용" items={summary.discussion} />
      <Section title="결정 사항" items={summary.decisions} />
      <Section title="액션 아이템" items={actionLines} />
      <Section title="리스크" items={summary.risks} />
      <Section title="후속 확인" items={summary.followups} />
    </div>
  );
}

function ReviewForm({
  id,
  participants,
  onSaved,
}: {
  id: string;
  participants: string[];
  onSaved(participants: string[]): void;
}) {
  const externalText = participants.join(", ");
  const [draft, setDraft] = useState(externalText);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (dirty) return;
    setDraft(externalText);
  }, [dirty, externalText]);

  const toList = (s: string) =>
    s
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/meetings/${id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          participants: toList(draft),
        }),
      });
      if (!res.ok) throw new Error("review save refused");
      const body: unknown = await res.json();
      if (
        typeof body !== "object"
        || body === null
        || !("review" in body)
        || typeof body.review !== "object"
        || body.review === null
        || !("participants" in body.review)
        || !Array.isArray(body.review.participants)
        || !body.review.participants.every((value) => typeof value === "string")
      ) {
        throw new Error("invalid review response");
      }
      const normalized = toList(body.review.participants.join(","));
      setDraft(normalized.join(", "));
      setDirty(false);
      setFeedback({ kind: "success", text: "저장됨" });
      onSaved(normalized);
    } catch {
      setFeedback({ kind: "error", text: "참석자를 저장하지 못했습니다. 입력을 유지했으니 다시 시도하세요." });
    } finally {
      setSaving(false);
    }
  };

  const inputId = `participants-${id}`;
  const helpId = `participants-help-${id}`;
  const statusId = `participants-status-${id}`;

  return (
    <form
      onSubmit={(e) => void submit(e)}
      aria-labelledby={`participants-heading-${id}`}
      className="rounded-[16px] border border-line bg-panel p-4 sm:p-5"
    >
      <h3 id={`participants-heading-${id}`} className="text-[16px] font-bold text-ink">참석자</h3>
      <p id={helpId} className="mt-1 text-[13px] text-inkSoft">
        쉼표로 구분해 입력하세요. 참석자는 이 입력이 유일한 출처입니다.
      </p>
      <label htmlFor={inputId} className="mt-4 block text-[13px] font-medium text-inkSoft">참석자</label>
      <input
        id={inputId}
        className="mt-1 min-h-11 w-full rounded-md border border-line bg-panel px-3 py-2 text-[14px] text-ink placeholder:text-inkSoft focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          setDirty(next !== externalText);
          setFeedback(null);
        }}
        aria-describedby={`${helpId} ${statusId}`}
        placeholder="예: 딜런, 지훈"
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-ink px-5 py-2 text-[14px] font-semibold text-bg transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {saving ? "저장 중…" : "저장"}
        </button>
        <p
          id={statusId}
          role="status"
          aria-live="polite"
          className={`min-w-0 text-[13px] ${feedback?.kind === "error" ? "text-error" : "text-success"}`}
        >
          {saving ? "저장 중…" : feedback?.text ?? ""}
        </p>
      </div>
    </form>
  );
}
