import { existsSync, readFileSync } from "node:fs";

import Link from "next/link";

import { MeetingDetailView, type Segment } from "@/components/MeetingDetailView";
import type { Summary } from "@/domain/summary";
import { summarySchema } from "@/domain/summarySchema";
import { assertSafeId } from "@/lib/meetingId";
import { meetingPaths } from "@/lib/paths";
import { deriveStatus, readStatus } from "@/lib/status";
import { isSummarizeInflight } from "@/lib/summarize";

// Reads data/ artifacts at request time → must be dynamic + Node runtime. This is a
// read-only view: it derives the display status (title promotion) but never
// persists — app-api's GET route remains the sole writer.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function readSegments(path: string): Segment[] {
  const raw = readText(path);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is Segment =>
          typeof s === "object" && s !== null &&
          typeof (s as Segment).start === "number" &&
          typeof (s as Segment).end === "number" &&
          typeof (s as Segment).text === "string",
      );
  } catch {
    return [];
  }
}

function readSummary(path: string): Summary | null {
  const raw = readText(path);
  if (!raw) return null;
  try {
    const parsed = summarySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function NotFound() {
  return (
    <main id="main" className="max-w-5xl px-6 py-16">
      <h1 className="text-xl font-bold text-ink">회의를 찾을 수 없습니다</h1>
      <Link href="/" className="mt-4 inline-block text-[14px] text-accent hover:underline">
        ← 목록으로
      </Link>
    </main>
  );
}

export default async function MeetingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  let id: string;
  try {
    id = assertSafeId((await params).id);
  } catch {
    return <NotFound />;
  }

  const persisted = await readStatus(id);
  if (!persisted) return <NotFound />;

  const { status } = deriveStatus(id, persisted);
  const p = meetingPaths(id);

  const correctedText = readText(p.transcript);
  const transcript = correctedText !== null
    ? { text: correctedText, corrected: true }
    : { text: readText(p.raw) ?? "", corrected: false };

  return (
    <MeetingDetailView
      id={id}
      status={status}
      transcript={transcript}
      segments={readSegments(p.segments)}
      summary={readSummary(p.summary)}
      hasAudio={existsSync(p.play) || existsSync(p.audio)}
      resummarizeInflight={isSummarizeInflight(id)}
    />
  );
}
