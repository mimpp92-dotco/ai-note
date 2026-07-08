"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";

import { CopyButton } from "@/components/CopyButton";
import type { StatusJson } from "@/domain/meeting";
import type { Summary } from "@/domain/summary";
import { formatMeetingDate, STATUS_LABELS } from "@/lib/meetingLabels";
import { formatDuration } from "@/lib/recorder";

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

// The next Claude Code command for this meeting's lifecycle stage. null when there
// is nothing to run yet (still transcribing) or already summarized.
function nextCommand(status: StatusJson["status"]): string | null {
  if (status === "transcribed") return "/meeting-summarize";
  return null;
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
  const [tab, setTab] = useState<"script" | "summary">("script");
  const command = nextCommand(status.status);

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-6 py-12">
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

      {command && (
        <div className="overflow-hidden rounded-[12px] border border-line">
          <div className="flex items-center gap-1.5 bg-chrome px-4 py-2.5">
            <span className="h-3 w-3 rounded-full bg-error/70" aria-hidden="true" />
            <span className="h-3 w-3 rounded-full bg-warn/70" aria-hidden="true" />
            <span className="h-3 w-3 rounded-full bg-success/70" aria-hidden="true" />
            <span className="ml-2 text-[12px] text-inkSoft">다음 단계 — 터미널에서 실행</span>
          </div>
          <div className="flex items-center justify-between gap-4 bg-ink px-4 py-3">
            <code className="font-mono text-[14px] text-bg">
              {command} {id}
            </code>
            <CopyButton text={`${command} ${id}`} label="복사" />
          </div>
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
    return (
      <p className="text-[14px] text-inkSoft">
        아직 요약이 없습니다 — 터미널에서 <code className="font-mono text-accent">/meeting-summarize</code> 실행
      </p>
    );
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
