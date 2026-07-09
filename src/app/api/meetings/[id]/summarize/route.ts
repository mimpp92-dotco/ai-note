import { NextResponse } from "next/server";

import { assertSafeId } from "@/lib/meetingId";
import { readStatus, writeStatus } from "@/lib/status";
import { runSummarize } from "@/lib/summarize";

// POST /api/meetings/[id]/summarize — user-initiated (re)summarize. Resets the
// attempt counter first so a manual retry always runs even after the worker has
// backed off, then delegates to runSummarize (the shared, locked orchestrator).
// Body { resummarize: true } forces a regeneration of an already-summarized
// meeting ("다시 요약"); without it an existing summary still 409s (no accidental
// re-summarize).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let id: string;
  try {
    id = assertSafeId((await params).id);
  } catch {
    return NextResponse.json({ error: "invalid meeting id" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as { resummarize?: boolean } | null;
  const force = body?.resummarize === true;

  const st = await readStatus(id);
  if (st) await writeStatus(id, { ...st, summarizeAttempts: 0 });

  const r = await runSummarize(id, { force });
  if (r.ok) return NextResponse.json({ ok: true });

  switch (r.reason) {
    case "in_progress":
      return NextResponse.json({ error: "summarize in progress" }, { status: 409 });
    case "not_found":
      return NextResponse.json({ error: "not found" }, { status: 404 });
    case "no_model":
      return NextResponse.json({ error: "no model configured" }, { status: 400 });
    case "already_summarized":
      return NextResponse.json({ error: "already summarized" }, { status: 409 });
    case "error":
      return NextResponse.json({ error: r.message }, { status: 502 });
  }
}
