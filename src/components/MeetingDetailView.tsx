"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";

import { CopyButton } from "@/components/CopyButton";
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
}

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

export function MeetingDetailView({ id, status, transcript, segments, summary, hasAudio }: MeetingDetailData) {
  const router = useRouter();
  const [tab, setTab] = useState<"script" | "summary">("script");
  const [retrying, setRetrying] = useState(false);

  // Whether a summarizer model is set (shared health hook) so the `transcribed`
  // hint can point to settings when it's missing. The app summarizes in-process.
  const { llm } = useHealth();
  const configured = llm === null ? null : llm.configured;

  // While summarizing, refresh server data so the finished summary appears without a
  // manual reload (status is file-derived by the server page).
  useEffect(() => {
    if (status.status !== "summarizing") return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [status.status, router]);

  const retry = async () => {
    setRetrying(true);
    try {
      await fetch(`/api/meetings/${id}/summarize`, { method: "POST" });
      router.refresh();
    } finally {
      setRetrying(false);
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

      <StatusCard status={status} configured={configured} onRetry={() => void retry()} retrying={retrying} />

      {status.status === "summarized" && summary && (
        <ExportToolbar
          id={id}
          summary={summary}
          transcript={transcript.text}
          participants={status.review.participants}
        />
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

// Lifecycle card above the tabs: surfaces a summarize failure (with retry), the
// in-progress spinner, or the transcribed→summary hint. null once summarized.
function StatusCard({
  status,
  configured,
  onRetry,
  retrying,
}: {
  status: StatusJson;
  configured: boolean | null;
  onRetry: () => void;
  retrying: boolean;
}) {
  if (status.error?.action === "retry_summary") {
    return (
      <div className="flex items-center justify-between gap-4 rounded-[12px] border border-error/40 bg-error/10 px-5 py-4">
        <p className="text-[14px] text-ink">
          <span className="font-semibold text-error">요약 실패</span> — {status.error.message}
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
    if (configured === false) {
      return (
        <div className="flex items-center justify-between gap-4 rounded-[12px] border border-warn/40 bg-warnBg px-5 py-4">
          <p className="text-[14px] text-ink">요약하려면 모델을 설정하세요.</p>
          <Link
            href="/settings"
            className="shrink-0 rounded-md border border-line bg-panel px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:bg-soft"
          >
            설정
          </Link>
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
