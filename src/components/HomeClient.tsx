"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AiModelPill, type LlmHealthState } from "@/components/AiModelPill";
import { EmptyState } from "@/components/EmptyState";
import { MeetingList, type MeetingListItem } from "@/components/MeetingList";
import { PendingBanner } from "@/components/PendingBanner";
import { Recorder } from "@/components/Recorder";
import { WhisperPill } from "@/components/WhisperPill";

const MEETINGS_POLL_MS = 3000;
const HEALTH_POLL_MS = 5000;
const LLM_HEALTH_POLL_MS = 10000;

// Client home dashboard. Reads state through app-api (force-dynamic routes) with
// no-store polling; never touches the filesystem or an LLM directly.
export function HomeClient() {
  const [meetings, setMeetings] = useState<MeetingListItem[] | null>(null);
  const [health, setHealth] = useState<{ connected: boolean } | null>(null);
  const [llmHealth, setLlmHealth] = useState<LlmHealthState | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch("/api/meetings", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { meetings: MeetingListItem[] };
        if (active) setMeetings(data.meetings);
      } catch {
        // Transient — keep the last known list.
      }
    };
    void load();
    const timer = setInterval(() => void load(), MEETINGS_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch("/api/whisper/health", { cache: "no-store" });
        const data = (await res.json()) as { connected: boolean };
        if (active) setHealth(data);
      } catch {
        if (active) setHealth({ connected: false });
      }
    };
    void load();
    const timer = setInterval(() => void load(), HEALTH_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch("/api/settings/llm/health", { cache: "no-store" });
        const data = (await res.json()) as LlmHealthState;
        if (active) setLlmHealth(data);
      } catch {
        // Transient — keep the last known state.
      }
    };
    void load();
    const timer = setInterval(() => void load(), LLM_HEALTH_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const pendingCount = (meetings ?? []).filter((m) => m.status === "transcribed").length;
  const modelConfigured = llmHealth === null ? null : llmHealth.configured;

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-6 py-12">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">AI NOTE</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-inkSoft">
            회의 녹음 → 로컬 전사 → 회의록 요약.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <AiModelPill health={llmHealth} loading={llmHealth === null} />
          <WhisperPill connected={health?.connected ?? false} loading={health === null} />
          <Link
            href="/settings"
            aria-label="설정"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line bg-panel text-inkSoft transition-colors hover:bg-soft hover:text-ink"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
              <path
                d="M12 15a3 3 0 100-6 3 3 0 000 6z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008.6 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 110-4h.09A1.65 1.65 0 004.6 8.6a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V2a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H22a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        </div>
      </header>

      <Recorder />

      <PendingBanner count={pendingCount} configured={modelConfigured} />

      {meetings !== null &&
        (meetings.length === 0 ? (
          <EmptyState />
        ) : (
          <section className="space-y-4">
            <h2 className="text-[16px] font-bold text-ink">회의 목록</h2>
            <MeetingList meetings={meetings} />
          </section>
        ))}
    </main>
  );
}
