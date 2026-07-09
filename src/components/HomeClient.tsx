"use client";

import { useEffect, useRef, useState } from "react";

import { EmptyState } from "@/components/EmptyState";
import { MeetingList, type MeetingListItem } from "@/components/MeetingList";
import { PendingBanner } from "@/components/PendingBanner";
import { Recorder } from "@/components/Recorder";
import { useHealth } from "@/components/useHealth";

const MEETINGS_POLL_MS = 3000;

// Module-level cache: persists the list across client navigations so returning to
// home doesn't refetch-flash. Health pills/onboarding read the shared useHealth hook.
let meetingsCache: MeetingListItem[] | null = null;

// Client home dashboard. Reads state through app-api (force-dynamic routes) with
// no-store polling; never touches the filesystem or an LLM directly.
export function HomeClient() {
  const [meetings, setMeetings] = useState<MeetingListItem[] | null>(meetingsCache);
  // Bumped on every optimistic row mutation so an in-flight poll dispatched before
  // the mutation can't clobber it with a pre-mutation server snapshot.
  const mutationEpoch = useRef(0);
  const { llm } = useHealth();

  useEffect(() => {
    let active = true;
    const load = async () => {
      const startEpoch = mutationEpoch.current;
      try {
        const res = await fetch("/api/meetings", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { meetings: MeetingListItem[] };
        // Drop a snapshot that predates a rename/delete made while it was in
        // flight — the next poll supplies the authoritative (post-mutation) list.
        if (!active || mutationEpoch.current !== startEpoch) return;
        meetingsCache = data.meetings;
        setMeetings(data.meetings);
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

  const pendingCount = (meetings ?? []).filter((m) => m.status === "transcribed").length;
  const modelConfigured = llm === null ? null : llm.configured;

  // Row-action callbacks: merge/remove the one item (server already persisted the
  // change, so the next 3s poll confirms). Update meetingsCache too so a remount
  // before the next poll doesn't flash the stale entry.
  const handleRenamed = (id: string, title: string) => {
    mutationEpoch.current += 1;
    setMeetings((prev) => {
      const next = (prev ?? []).map((m) => (m.id === id ? { ...m, title } : m));
      meetingsCache = next;
      return next;
    });
  };
  const handleDeleted = (id: string) => {
    mutationEpoch.current += 1;
    setMeetings((prev) => {
      const next = (prev ?? []).filter((m) => m.id !== id);
      meetingsCache = next;
      return next;
    });
  };

  return (
    <main id="main" className="max-w-5xl space-y-8 px-6 py-12">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink">회의록</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-inkSoft">
          회의 녹음 → 로컬 전사 → 회의록 요약.
        </p>
      </header>

      <Recorder />

      <PendingBanner count={pendingCount} configured={modelConfigured} />

      {meetings !== null &&
        (meetings.length === 0 ? (
          <EmptyState />
        ) : (
          <section className="space-y-4">
            <h2 className="text-[16px] font-bold text-ink">회의 목록</h2>
            <MeetingList meetings={meetings} onRenamed={handleRenamed} onDeleted={handleDeleted} />
          </section>
        ))}
    </main>
  );
}
