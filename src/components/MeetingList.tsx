import Link from "next/link";

import type { MeetingStatus, StatusError } from "@/domain/meeting";
import { formatMeetingDate, STATUS_LABELS } from "@/lib/meetingLabels";

export interface MeetingListItem {
  id: string;
  title: string;
  status: MeetingStatus;
  startedAt: string;
  error: StatusError | null;
}

// Meeting cards (title · date · status label). Each links to its detail page. The
// status badge surfaces the summarizer lifecycle: a spinner while summarizing and
// a "요약 실패" badge when a summarize error awaits a manual retry.
export function MeetingList({ meetings }: { meetings: MeetingListItem[] }) {
  return (
    <ul className="space-y-3">
      {meetings.map((m) => (
        <li key={m.id}>
          <Link
            href={`/meetings/${m.id}`}
            className="flex items-center justify-between gap-4 rounded-[14px] border border-line bg-panel px-5 py-4 shadow-[0_1px_2px_rgba(42,36,32,.04)] transition-colors hover:bg-chrome"
          >
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold text-ink">{m.title}</span>
              <span className="mt-0.5 block font-mono text-[12px] text-inkSoft">
                {formatMeetingDate(m.startedAt)}
              </span>
            </span>
            <StatusBadge status={m.status} error={m.error} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function StatusBadge({ status, error }: { status: MeetingStatus; error: StatusError | null }) {
  if (error?.action === "retry_summary") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-error/10 px-3 py-1 text-[12px] font-medium text-error">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-error" aria-hidden="true" />
        요약 실패
      </span>
    );
  }

  if (status === "summarizing") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-soft px-3 py-1 text-[12px] font-medium text-inkSoft">
        <span
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
          aria-hidden="true"
        />
        요약 중
      </span>
    );
  }

  return (
    <span className="shrink-0 rounded-full bg-soft px-3 py-1 text-[12px] font-medium text-inkSoft">
      {STATUS_LABELS[status]}
    </span>
  );
}
