import type { MeetingStatus } from "@/domain/meeting";

// Short lifecycle labels for the list/detail views (icon+text per UI_GUIDE — status
// is never conveyed by color alone). The recorder flow keeps its own phrasing.
export const STATUS_LABELS: Record<MeetingStatus, string> = {
  recording: "녹음 중",
  recorded: "전사 대기",
  transcribing: "전사 중",
  transcribed: "교정 대기",
  summarizing: "요약 생성 중",
  summarized: "요약 완료",
};

// ISO → "YYYY-MM-DD HH:mm" in local time. Returns "" for an unparseable value so a
// missing/garbled timestamp never throws in render.
export function formatMeetingDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
