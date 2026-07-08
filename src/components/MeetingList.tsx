import Link from "next/link";

import type { MeetingStatus } from "@/domain/meeting";
import { formatMeetingDate, STATUS_LABELS } from "@/lib/meetingLabels";

export interface MeetingListItem {
  id: string;
  title: string;
  status: MeetingStatus;
  startedAt: string;
}

// Meeting cards (title · date · status label). Each links to its detail page.
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
            <span className="shrink-0 rounded-full bg-soft px-3 py-1 text-[12px] font-medium text-inkSoft">
              {STATUS_LABELS[m.status]}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
