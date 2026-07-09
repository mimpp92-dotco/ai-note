import { NextResponse } from "next/server";
import { z } from "zod";

import { assertSafeId } from "@/lib/meetingId";
import { deriveStatus, readStatus, writeStatus } from "@/lib/status";

// POST /api/meetings/[id]/title — set a manual display title. Only allowed once
// the meeting is summarized (derived state), and stored as titleOverride so
// deriveStatus keeps it over the summarizer's title (see status.ts). app-api is
// the single writer of status.json.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const titleSchema = z.object({ title: z.string().trim().min(1).max(200) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let id: string;
  try {
    id = assertSafeId((await params).id);
  } catch {
    return NextResponse.json({ error: "invalid meeting id" }, { status: 400 });
  }

  const parsed = titleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid title" }, { status: 400 });
  }
  const { title } = parsed.data;

  const persisted = await readStatus(id);
  if (!persisted) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Gate on the DERIVED state, not persisted: a meeting summarized by the manual
  // /meeting-summarize skill can leave status.json at "transcribed" while
  // summary.json exists — persisted alone would 409 a legitimately-summarized one.
  const { status: derived } = deriveStatus(id, persisted);
  if (derived.status !== "summarized") {
    return NextResponse.json({ error: "not summarized yet" }, { status: 409 });
  }

  // Write the derived object so a lagging status.json is reconciled to
  // "summarized" by the same write. titleOverride pins the manual title.
  await writeStatus(id, { ...derived, title, titleOverride: title });
  return NextResponse.json({ ok: true, title });
}
