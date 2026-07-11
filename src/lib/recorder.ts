// Pure, browser-API-free helpers for the recorder. Kept separate from the hook so
// they are unit-testable in jsdom/node — MediaRecorder / AudioContext do not exist
// there, so the hook injects the real predicates/data and only these functions hold
// the logic worth testing.

// mime preference, most-preferred first. Chrome/Firefox record webm/opus; Safari has
// no webm support and falls through to mp4, then ogg.
export const AUDIO_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
] as const;

// Pick the first candidate the platform can actually record. Returns "" when none
// match, letting MediaRecorder fall back to its own default (finalize then reads the
// recorded blob's content-type).
export function pickAudioMime(
  isSupported: (mime: string) => boolean,
  candidates: readonly string[] = AUDIO_MIME_CANDIDATES,
): string {
  for (const mime of candidates) {
    if (isSupported(mime)) return mime;
  }
  return "";
}

// Root-mean-square of time-domain PCM samples. getFloatTimeDomainData yields values
// in ~[-1, 1]; the result is the 0..~1 input level that drives the meter. Empty → 0.
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

// Elapsed time as mm:ss. Minutes are not capped at 60 — a 75-minute meeting reads
// "75:00". Negative / NaN input clamps to "00:00".
export function formatDuration(ms: number): string {
  const totalSeconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// Short, phase-only screen-reader announcement for a recorder lifecycle phase.
// Deliberately excludes the ticking mm:ss timer and the input meter value so a
// dedicated polite status announces once per transition — not on every tick.
// `idle` returns "" so the resting state announces nothing.
export function recorderPhaseAnnouncement(phase: string): string {
  switch (phase) {
    case "requesting_permission":
      return "권한 확인";
    case "recording":
      return "기록 시작";
    case "stopping":
    case "captured":
      return "정리";
    case "uploading":
      return "저장";
    case "saved":
      return "저장 완료";
    case "finalize_ambiguous":
      return "저장 상태 확인 필요";
    case "failed":
      return "실패";
    default:
      return "";
  }
}
