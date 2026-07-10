import { existsSync } from "node:fs";

import { NextResponse } from "next/server";

import { assertSafeId } from "@/lib/meetingId";
import { meetingPaths } from "@/lib/paths";
import { readStatus, writeStatus } from "@/lib/status";
import { isSummarizeInflight, runSummarize } from "@/lib/summarize";
import { getConfiguredAdapter } from "@/services/llm";

// POST /api/meetings/[id]/summarize — user-initiated (re)summarize. Correction +
// summary can take minutes on a long meeting, so this does NOT block on the work:
// it validates synchronously, fires runSummarize (fire-and-forget), and returns 202.
// The client polls (router.refresh) for the new summary or a retry_summary failure.
// Body { resummarize: true } forces regenerating an already-summarized meeting
// ("다시 요약"); without it an existing summary still 409s (no accidental re-summarize,
// so glossary saves / the worker sweep can never trigger one).
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

  // Synchronous pre-flight: because the summarize is fired-and-forgotten below, its
  // own guards (runSummarize returns in_progress/not_found/no_model/already_summarized)
  // can't be turned into HTTP codes after the fact — so mirror them here.
  const st = await readStatus(id);
  if (!st) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (isSummarizeInflight(id)) {
    return NextResponse.json({ error: "summarize in progress" }, { status: 409 });
  }
  if (!(await getConfiguredAdapter())) {
    return NextResponse.json({ error: "no model configured" }, { status: 400 });
  }
  if (!force && existsSync(meetingPaths(id).summary)) {
    return NextResponse.json({ error: "already summarized" }, { status: 409 });
  }

  // Reset the attempt counter so a manual retry runs even after the worker backed
  // off. runSummarize owns the rest of status.json (summarizing / error:null on
  // start, and the final summarized / failure state).
  await writeStatus(id, { ...st, summarizeAttempts: 0 });

  // Fire-and-forget. .catch keeps a rejected run from becoming an unhandled
  // rejection; the failure is recorded in status.json for the client to observe.
  void runSummarize(id, { force }).catch(() => {});

  return NextResponse.json({ ok: true }, { status: 202 });
}
