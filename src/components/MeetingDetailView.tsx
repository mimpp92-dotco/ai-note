"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { CopyButton } from "@/components/CopyButton";
import { type LlmReadiness, getLlmReadiness } from "@/components/healthStatus";
import { useHealth } from "@/components/useHealth";
import type { StatusJson } from "@/domain/meeting";
import type { Summary } from "@/domain/summary";
import { formatMeetingDate, STATUS_LABELS } from "@/lib/meetingLabels";
import { formatDuration } from "@/lib/recorder";
import { formatSummaryMarkdown } from "@/lib/summaryMarkdown";

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface MeetingDetailData {
  id: string;
  status: StatusJson;
  transcript: { text: string; corrected: boolean };
  segments: Segment[];
  summary: Summary | null;
  hasAudio: boolean;
  // True while a summarize holds the in-flight lock for this meeting (server-derived
  // from isSummarizeInflight). The manual re-summarize poll uses it to detect
  // completion even when the summary content is unchanged. Optional/defaults false.
  resummarizeInflight?: boolean;
}

// The server may run up to three sequential LLM calls per (re)summarize — correction,
// summary, and an optional fallback summary — each capped at 600s
// (LLM_GENERATION_TIMEOUT_MS in src/services/llm/exec.ts, kept in sync by this
// derivation). Poll past that worst case before declaring a timeout so a slow
// long-meeting re-summarize (the exact case the 600s cap exists for) isn't falsely
// reported as failed. Not imported from exec.ts: that module pulls in node:child_process.
const RESUMMARIZE_TIMEOUT_MS = 3 * 600_000 + 30_000; // ~30.5 min

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
}: MeetingDetailData) {
  const router = useRouter();
  const [tab, setTab] = useState<"script" | "summary">("script");
  const [resummarizing, setResummarizing] = useState(false);
  const [resummarizeError, setResummarizeError] = useState<string | null>(null);

  // Shared health hook lets transcribed meetings distinguish ready, missing, and
  // unavailable summarizers before promising automatic processing.
  const { llm } = useHealth();
  const readiness = getLlmReadiness(llm);

  // A manual (re)summarize is async: the route returns 202 and the work runs in the
  // background. deriveStatus masks the transient `summarizing` as `summarized` while
  // the previous summary.json still exists, so we can't watch status.status. Completion
  // is detected instead from (a) the summary content changing, or (b) the server's
  // in-flight lock clearing after we've observed it held (resummarizeInflight), with a
  // ceiling as a last resort.
  const baseSummarySig = useRef<string | null>(null);
  const seenInflight = useRef(false);
  const deadline = useRef(0);

  // Auto-summary (worker-driven): the server-derived status is genuinely
  // `summarizing` (no summary.json yet), so refresh until the summary appears.
  // Skipped during a manual re-summarize, which drives its own poll below.
  useEffect(() => {
    if (status.status !== "summarizing" || resummarizing) return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [status.status, resummarizing, router]);

  // Manual re-summarize: poll for fresh server data; give up at the ceiling.
  useEffect(() => {
    if (!resummarizing) return;
    const timer = setInterval(() => {
      if (Date.now() > deadline.current) {
        setResummarizing(false);
        setResummarizeError("재요약이 시간 내에 끝나지 않았어요. 잠시 후 다시 시도하세요.");
        return;
      }
      router.refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [resummarizing, router]);

  // Detect completion of a manual re-summarize from refreshed server props.
  useEffect(() => {
    if (!resummarizing) return;

    // (a) New summary content is an unambiguous success, independent of the lock — the
    // baseline was captured at begin, so a change means fresh data has arrived. Checked
    // first so it also covers a run that finishes before a poll observes the lock.
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
    // in flight from a fresh poll — otherwise stale props from before the run started
    // (an old retry_summary error, or the pre-run unlocked state) would read as an
    // instant completion.
    if (!seenInflight.current) return;
    if (status.error?.action === "retry_summary") {
      setResummarizing(false); // failure surfaces via the StatusCard banner
    } else {
      setResummarizing(false); // lock released, no error, no content delta → success (identical regen)
      setResummarizeError(null);
    }
  }, [resummarizing, resummarizeInflight, summary, status]);

  const beginResummarize = async (force: boolean) => {
    if (resummarizing) return;
    baseSummarySig.current = summary ? JSON.stringify(summary) : null;
    seenInflight.current = false;
    deadline.current = Date.now() + RESUMMARIZE_TIMEOUT_MS;
    setResummarizeError(null);
    setResummarizing(true);
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

  return (
    <main id="main" className="max-w-5xl space-y-8 px-6 py-12">
      <div>
        <Link href="/" className="text-[13px] text-inkSoft hover:text-accent">
          ← 목록
        </Link>
        <div className="mt-3 flex items-center justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight text-ink">{status.title}</h1>
          <span className="shrink-0 rounded-full bg-soft px-3 py-1 text-[12px] font-medium text-inkSoft">
            {STATUS_LABELS[status.status]}
          </span>
        </div>
        <p className="mt-1 font-mono text-[12px] text-inkSoft">{formatMeetingDate(status.startedAt)}</p>
      </div>

      <StatusCard
        status={status}
        readiness={readiness}
        onRetry={() => void beginResummarize(summary != null)}
        retrying={resummarizing}
      />

      {status.status === "summarized" && summary && (
        <div className="space-y-3">
          <ExportToolbar
            id={id}
            summary={summary}
            transcript={transcript.text}
            participants={status.review.participants}
          />
          <ResummarizeControl
            busy={resummarizing}
            error={resummarizeError}
            onRun={() => void beginResummarize(true)}
          />
        </div>
      )}

      <div>
        <div role="tablist" className="flex gap-1 border-b border-line">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "script"}
            onClick={() => setTab("script")}
            className={`-mb-px border-b-2 px-4 py-2.5 text-[14px] font-medium transition-colors ${
              tab === "script" ? "border-accent text-ink" : "border-transparent text-inkSoft hover:text-ink"
            }`}
          >
            전체 스크립트
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "summary"}
            onClick={() => setTab("summary")}
            className={`-mb-px border-b-2 px-4 py-2.5 text-[14px] font-medium transition-colors ${
              tab === "summary" ? "border-accent text-ink" : "border-transparent text-inkSoft hover:text-ink"
            }`}
          >
            회의록 요약
          </button>
        </div>

        <div className="pt-5">
          {tab === "script" ? (
            <ScriptTab transcript={transcript} segments={segments} />
          ) : (
            <SummaryTab summary={summary} />
          )}
        </div>
      </div>

      {hasAudio && (
        <div>
          <h2 className="text-[14px] font-bold text-ink">녹음 재생</h2>
          <audio controls src={`/api/meetings/${id}/audio`} className="mt-2 w-full" />
        </div>
      )}

      <ReviewForm id={id} review={status.review} />
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

// Manual single-meeting re-summarize ("다시 요약"). Only shown once summarized; it
// regenerates transcript.md + summary.json (POST { resummarize: true }) so a glossary
// change can be applied to an existing meeting. There is no bulk/auto re-summarize.
// The run + async completion polling live in the parent (MeetingDetailView) so the
// StatusCard retry and this control share one in-flight state; this component owns
// only the confirm step. `busy` reflects that shared re-summarize; `error` carries a
// synchronous refusal (409/no-model) or a timeout.
function ResummarizeControl({
  onRun,
  busy,
  error,
}: {
  onRun: () => void;
  busy: boolean;
  error: string | null;
}) {
  const [confirming, setConfirming] = useState(false);

  // Close the confirm panel once a run finishes cleanly; keep it open on error so the
  // message and a retry stay visible.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
    } else if (wasBusy.current) {
      wasBusy.current = false;
      if (!error) setConfirming(false);
    }
  }, [busy, error]);

  if (!confirming) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => setConfirming(true)}
        className="rounded-full border border-line bg-panel px-4 py-1.5 text-[13px] font-medium text-accent transition-colors hover:bg-soft disabled:opacity-50"
      >
        {busy ? "요약 중…" : "다시 요약"}
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] border border-line bg-soft px-4 py-3">
      <p className="text-[13px] text-ink">현재 요약을 새로 생성합니다(단어장 변경 반영).</p>
      <button
        type="button"
        onClick={onRun}
        disabled={busy}
        className="rounded-full bg-ink px-4 py-1.5 text-[13px] font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-50"
      >
        {busy ? "요약 중…" : "다시 요약"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={busy}
        className="rounded-full border border-line bg-panel px-4 py-1.5 text-[13px] font-semibold text-accent transition-colors hover:bg-soft disabled:opacity-50"
      >
        취소
      </button>
      {error && (
        <span role="status" aria-live="polite" className="text-[13px] text-error">
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
  onRetry,
  retrying,
}: {
  status: StatusJson;
  readiness: LlmReadiness;
  onRetry: () => void;
  retrying: boolean;
}) {
  if (status.error?.action === "retry_summary") {
    // A re-summarize failure keeps `summarized` (the prior summary survives); a
    // first-time failure sits at `transcribed`. Word the banner to match.
    const label = status.status === "summarized" ? "재요약 실패" : "요약 실패";
    return (
      <div className="flex items-center justify-between gap-4 rounded-[12px] border border-error/40 bg-error/10 px-5 py-4">
        <p className="text-[14px] text-ink">
          <span className="font-semibold text-error">{label}</span> — {status.error.message}
        </p>
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="shrink-0 rounded-full bg-ink px-5 py-2 text-[14px] font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-50"
        >
          {retrying ? "재시도 중…" : "재시도"}
        </button>
      </div>
    );
  }

  if (status.status === "summarizing") {
    return (
      <div className="flex items-center gap-3 rounded-[12px] border border-line bg-panel px-5 py-4">
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
          className={`flex items-center justify-between gap-4 rounded-[12px] border px-5 py-4 ${
            unavailable ? "border-error/40 bg-error/5" : "border-warn/40 bg-warnBg"
          }`}
        >
          <p className="text-[14px] text-ink">
            {unavailable ? "요약 모델을 확인하세요. 설정한 모델이 지금 사용할 수 없습니다." : "요약하려면 모델을 설정하세요."}
          </p>
          <Link
            href="/settings"
            className="shrink-0 rounded-md border border-line bg-panel px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:bg-soft"
          >
            설정
          </Link>
        </div>
      );
    }
    if (readiness === "loading") {
      return (
        <div className="flex items-center gap-3 rounded-[12px] border border-line bg-panel px-5 py-4">
          <Spinner />
          <p className="text-[14px] text-ink">요약 모델 확인 중…</p>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-3 rounded-[12px] border border-line bg-panel px-5 py-4">
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
  const anchor =
    "shrink-0 rounded-md border border-line bg-panel px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:bg-soft";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <CopyButton text={formatSummaryMarkdown(summary, participants)} label="요약 복사" />
      <CopyButton text={transcript} label="전사 복사" />
      <a href={`/api/meetings/${id}/export?fmt=md`} download className={anchor}>
        요약 다운로드(.md)
      </a>
      <a href={`/api/meetings/${id}/export?fmt=json`} download className={anchor}>
        JSON(.json)
      </a>
      <RevealButton id={id} />
    </div>
  );
}

function RevealButton({ id }: { id: string }) {
  const [pending, setPending] = useState(false);
  const open = async () => {
    setPending(true);
    try {
      await fetch(`/api/meetings/${id}/reveal`, { method: "POST" });
    } catch {
      // Best-effort — local folder reveal only.
    } finally {
      setPending(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void open()}
      disabled={pending}
      className="shrink-0 rounded-md border border-line bg-panel px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:bg-soft disabled:opacity-50"
    >
      {pending ? "여는 중…" : "폴더 열기"}
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

function ReviewForm({ id, review }: { id: string; review: StatusJson["review"] }) {
  const [participants, setParticipants] = useState(review.participants.join(", "));
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const toList = (s: string) =>
    s
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch(`/api/meetings/${id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          participants: toList(participants),
        }),
      });
      if (res.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  const field = "w-full rounded-md border border-line bg-panel px-3 py-2 text-[14px] text-ink placeholder:text-inkSoft focus:border-accent focus:outline-none";

  return (
    <form onSubmit={(e) => void submit(e)} className="rounded-[16px] border border-line bg-panel p-6">
      <h2 className="text-[16px] font-bold text-ink">참석자</h2>
      <p className="mt-1 text-[13px] text-inkSoft">쉼표로 구분해 입력하세요. 참석자는 이 입력이 유일한 출처입니다.</p>
      <div className="mt-4 space-y-4">
        <label className="block">
          <span className="text-[13px] font-medium text-inkSoft">참석자</span>
          <input
            className={`mt-1 ${field}`}
            value={participants}
            onChange={(e) => setParticipants(e.target.value)}
            placeholder="예: 딜런, 지훈"
          />
        </label>
      </div>
      <div className="mt-5 flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-full bg-ink px-5 py-2 text-[14px] font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-50"
        >
          {saving ? "저장 중…" : "저장"}
        </button>
        {saved && <span className="text-[13px] text-success">저장됨</span>}
      </div>
    </form>
  );
}
