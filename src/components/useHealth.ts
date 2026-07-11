"use client";

import { useEffect, useState } from "react";

import type { LlmHealthState, WhisperHealthState } from "@/components/healthStatus";

// Single shared health poller for the whole app. The LibraryNavigation rail
// (always mounted via the root layout), HomeClient's onboarding banner, and
// MeetingDetailView's hint all read from here, so there is exactly ONE poller
// regardless of how many components subscribe.
// Module-level state persists across client navigations (stale-while-revalidate),
// so pills never flash "확인 중" again after the first load.

const WHISPER_POLL_MS = 5000;
const LLM_POLL_MS = 10000;

export interface Health {
  whisper: WhisperHealthState | null;
  llm: LlmHealthState | null;
}

let state: Health = { whisper: null, llm: null };
const subscribers = new Set<() => void>();
let whisperTimer: ReturnType<typeof setInterval> | null = null;
let llmTimer: ReturnType<typeof setInterval> | null = null;
let refCount = 0;
// Per-endpoint in-flight guards so a slow health call can't stack on the next
// poll tick. Reset in finally so a rejected fetch never wedges the poller.
let whisperInflight = false;
let llmInflight = false;

function emit(patch: Partial<Health>) {
  state = { ...state, ...patch };
  subscribers.forEach((fn) => fn());
}

async function loadWhisper() {
  if (whisperInflight) return;
  whisperInflight = true;
  try {
    const res = await fetch("/api/whisper/health", { cache: "no-store" });
    emit({ whisper: (await res.json()) as WhisperHealthState });
  } catch {
    emit({ whisper: { connected: false } });
  } finally {
    whisperInflight = false;
  }
}

async function loadLlm() {
  if (llmInflight) return;
  llmInflight = true;
  try {
    const res = await fetch("/api/settings/llm/health", { cache: "no-store" });
    emit({ llm: (await res.json()) as LlmHealthState });
  } catch {
    // Transient — keep the last known state.
  } finally {
    llmInflight = false;
  }
}

function startPolling() {
  if (whisperTimer) return; // already running
  void loadWhisper();
  void loadLlm();
  whisperTimer = setInterval(() => void loadWhisper(), WHISPER_POLL_MS);
  llmTimer = setInterval(() => void loadLlm(), LLM_POLL_MS);
}

function stopPolling() {
  if (whisperTimer) clearInterval(whisperTimer);
  if (llmTimer) clearInterval(llmTimer);
  whisperTimer = null;
  llmTimer = null;
}

export function useHealth(): Health {
  const [snapshot, setSnapshot] = useState<Health>(state);

  useEffect(() => {
    const cb = () => setSnapshot(state);
    subscribers.add(cb);
    refCount += 1;
    startPolling();
    cb(); // sync any state that arrived before this subscribe
    return () => {
      subscribers.delete(cb);
      refCount -= 1;
      if (refCount === 0) stopPolling();
    };
  }, []);

  return snapshot;
}
