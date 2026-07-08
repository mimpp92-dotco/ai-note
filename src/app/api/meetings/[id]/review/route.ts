import { NextResponse } from "next/server";
import { z } from "zod";

import { assertSafeId } from "@/lib/meetingId";
import { readStatus, writeStatus } from "@/lib/status";

// POST /api/meetings/[id]/review — the user's authoritative participants input
// (docs/ARCHITECTURE.md: status.review). Written by app-api. The summarizer never
// infers attendees; this is the source of truth.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reviewSchema = z.object({
  participants: z.array(z.string()).default([]),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let id: string;
  try {
    id = assertSafeId((await params).id);
  } catch {
    return NextResponse.json({ error: "invalid meeting id" }, { status: 400 });
  }

  const parsed = reviewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid review body" }, { status: 400 });
  }

  const status = await readStatus(id);
  if (!status) return NextResponse.json({ error: "not found" }, { status: 404 });

  await writeStatus(id, { ...status, review: parsed.data });
  return NextResponse.json(await readStatus(id));
}
