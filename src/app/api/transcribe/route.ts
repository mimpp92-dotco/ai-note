import { NextResponse } from "next/server";

import { isSafeId } from "@/lib/meetingId";
import { readStatus, writeStatus } from "@/lib/status";
import { enqueueTranscription } from "@/lib/transcribe";

// POST /api/transcribe { id } — manual (re)enqueue, e.g. after a whisper outage on
// finalize. Same delegation path as finalize; whisper being unreachable maps to a
// retryable error + 502 (not a crash).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
  const id = body?.id;
  if (!isSafeId(id)) {
    return NextResponse.json({ error: "invalid meeting id" }, { status: 400 });
  }

  try {
    const result = await enqueueTranscription(id);
    if (!result.ok) {
      const code = result.reason === "not_found" ? 404 : 409;
      return NextResponse.json({ error: result.reason }, { status: code });
    }
    return NextResponse.json({ id, jobId: result.jobId, status: "transcribing" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = await readStatus(id);
    if (status) {
      await writeStatus(id, {
        ...status,
        error: { message, action: "retry_transcription" },
      });
    }
    return NextResponse.json({ error: "whisper unavailable", detail: message }, { status: 502 });
  }
}
