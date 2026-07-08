import { localSttBaseUrl } from "@/lib/config";

// Thin HTTP wrapper around the local whisper service (docs/ARCHITECTURE.md —
// whisper HTTP 계약). The base URL is read lazily from config inside each call
// (127.0.0.1:8123 default), so importing this module touches no env — build-green.

export interface WhisperHealth {
  ok: boolean;
  model: string;
  ready: boolean;
  message?: string;
}

export interface WhisperJob {
  status: "processing" | "done" | "error";
  progress: number;
  error?: string;
}

export interface EnqueueArgs {
  audioPath: string;
  rawPath: string;
  segmentsPath: string;
}

export async function fetchWhisperHealth(): Promise<WhisperHealth> {
  const res = await fetch(`${localSttBaseUrl()}/health`, { cache: "no-store" });
  if (!res.ok) throw new Error(`whisper /health returned ${res.status}`);
  return (await res.json()) as WhisperHealth;
}

export async function enqueueWhisperJob(args: EnqueueArgs): Promise<{ jobId: string }> {
  const res = await fetch(`${localSttBaseUrl()}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (res.status !== 202) {
    throw new Error(`whisper /transcribe returned ${res.status}`);
  }
  return (await res.json()) as { jobId: string };
}

export async function fetchWhisperJob(jobId: string): Promise<WhisperJob> {
  const res = await fetch(`${localSttBaseUrl()}/jobs/${jobId}`, { cache: "no-store" });
  return (await res.json()) as WhisperJob;
}
