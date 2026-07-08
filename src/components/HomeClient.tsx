"use client";

import { useEffect, useState } from "react";

import { EmptyState } from "@/components/EmptyState";
import { MeetingList, type MeetingListItem } from "@/components/MeetingList";
import { PendingBanner } from "@/components/PendingBanner";
import { Recorder } from "@/components/Recorder";
import { WhisperPill } from "@/components/WhisperPill";

const MEETINGS_POLL_MS = 3000;
const HEALTH_POLL_MS = 5000;

// Client home dashboard. Reads state through app-api (force-dynamic routes) with
// no-store polling; never touches the filesystem or an LLM directly.
export function HomeClient() {
  const [meetings, setMeetings] = useState<MeetingListItem[] | null>(null);
  const [health, setHealth] = useState<{ connected: boolean } | null>(null);

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

  const pendingCount = (meetings ?? []).filter((m) => m.status === "transcribed").length;

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-6 py-12">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">AI NOTE</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-inkSoft">
            회의 녹음 → 로컬 전사 → 회의록 요약.
          </p>
        </div>
        <WhisperPill connected={health?.connected ?? false} loading={health === null} />
      </header>

      <Recorder />

      <PendingBanner count={pendingCount} />

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
