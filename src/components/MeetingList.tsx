"use client";

import { MeetingRow } from "@/components/MeetingRow";
import type { MeetingStatus, StatusError } from "@/domain/meeting";

export interface MeetingListItem {
  id: string;
  title: string;
  status: MeetingStatus;
  startedAt: string;
  error: StatusError | null;
  location?: { workspaceId: string; folderId: string | null; breadcrumb: string[] };
  // Durable re-summarize signal (status.summarizeAttempt), surfaced by the list DTO. When
  // set, the row shows 요약 중 even though deriveStatus reports `summarized` (R6).
  resummarizeInflight?: boolean;
}

// Meeting cards (title · date · status label). Rendered inside the client
// HomeClient, which passes onRenamed/onDeleted so a row action (rename/delete)
// can update the shared meetings list. Each row owns its own kebab menu.
export function MeetingList({
  meetings,
  onRenamed,
  onDeleted,
  onMoved,
  detailHref,
}: {
  meetings: MeetingListItem[];
  onRenamed: (id: string, title: string) => void;
  onDeleted: (id: string) => void;
  onMoved?: (id: string, actual: { workspaceId: string; folderId: string | null }) => void;
  detailHref?: (meeting: MeetingListItem) => string;
}) {
  return (
    <ul className="w-full min-w-0 space-y-3">
      {meetings.map((m) => (
        <MeetingRow
          key={m.id}
          meeting={m}
          detailHref={detailHref?.(m)}
          onRenamed={onRenamed}
          onDeleted={onDeleted}
          onMoved={onMoved}
        />
      ))}
    </ul>
  );
}
