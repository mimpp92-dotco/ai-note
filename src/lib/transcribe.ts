import { meetingPaths } from "@/lib/paths";
import { readStatus, writeStatus } from "@/lib/status";
import { enqueueWhisperJob } from "@/services/whisperClient";

// Enqueue whisper transcription for a recorded meeting and move it to `transcribing`.
// Shared by POST /finalize (auto-delegate on stop) and POST /api/transcribe (retry).
// Original-immutability: raw.md/segments.json are whisper's; we only supply paths.

export type EnqueueResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: "not_found" | "already_transcribed" };

export async function enqueueTranscription(id: string): Promise<EnqueueResult> {
  const status = await readStatus(id);
  if (!status) return { ok: false, reason: "not_found" };
  // raw.md immutable → only (re)transcribe before it exists (recorded, or a failed
  // transcribing retry). transcribed/summarized are terminal for STT.
  if (status.status !== "recorded" && status.status !== "transcribing") {
    return { ok: false, reason: "already_transcribed" };
  }

  const p = meetingPaths(id);
  const { jobId } = await enqueueWhisperJob({
    audioPath: p.audio,
    rawPath: p.raw,
    segmentsPath: p.segments,
  });

  await writeStatus(id, {
    ...status,
    status: "transcribing",
    error: null,
    whisper: { jobId, progress: 0 },
  });
  return { ok: true, jobId };
}
