import { NextResponse } from "next/server";

import { deriveStatus, listMeetingIds, readStatus } from "@/lib/status";

// GET /api/meetings — list every meeting's status, newest first. Status is
// file-derived (deriveStatus) so the home banner sees transcribed/summarized even
// if status.json lags; this is a read-only view and does not persist.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const ids = await listMeetingIds();
  const meetings = [];
  for (const id of ids) {
    const persisted = await readStatus(id);
    if (!persisted) continue;
    meetings.push(deriveStatus(id, persisted).status);
  }
  meetings.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return NextResponse.json({ meetings });
}
