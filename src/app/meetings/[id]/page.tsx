import { existsSync, readFileSync } from "node:fs";

import Link from "next/link";
import { headers } from "next/headers";

import { MeetingDetailView, type Segment } from "@/components/MeetingDetailView";
import type { Summary } from "@/domain/summary";
import { summarySchema } from "@/domain/summarySchema";
import { readArtifactPair } from "@/lib/artifactPair";
import { resolveMeetingDetailSource } from "@/lib/detailSource";
import { readResolvedLibraryState } from "@/lib/libraryService";
import { isExactMeetingOperationActive } from "@/lib/meetingLifecycle";
import { assertSafeId } from "@/lib/meetingId";
import { inspectMeetingTombstone } from "@/lib/meetingTombstone";
import { validateLocalPageHeaders } from "@/lib/localRequestGuard";
import { meetingPaths } from "@/lib/paths";
import { toPublicMeeting } from "@/lib/publicApi";
import { deriveStatus, readStatus } from "@/lib/status";
import { inspectTranscriptionPublication } from "@/lib/transcriptionArtifacts";

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

function parseSummary(raw: string | null): Summary | null {
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

export default async function MeetingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requestHeaders = await headers();
  if (!validateLocalPageHeaders(requestHeaders).ok) return <NotFound />;

  let id: string;
  try {
    id = assertSafeId((await params).id);
  } catch {
    return <NotFound />;
  }
  if ((await inspectMeetingTombstone(id)).state !== "none") return <NotFound />;

  const persisted = await readStatus(id);
  if (!persisted) return <NotFound />;

  const p = meetingPaths(id);
  const pair = await readArtifactPair(id);
  const reconciledStatus = await readStatus(id);
  if (!reconciledStatus) return <NotFound />;
  const { status } = deriveStatus(id, reconciledStatus);
  const transcription = inspectTranscriptionPublication(
    id,
    status.transcriptionDispatch?.dispatchId,
  );

  const correctedText = pair.transcript;
  const parsedSummary = parseSummary(pair.summary);
  const transcript = correctedText !== null
    ? { text: correctedText, corrected: true }
    : {
        text: transcription.state === "complete" ? readText(p.raw) ?? "" : "",
        corrected: false,
      };
  const rawSearch = await searchParams;
  const sourceSearch = new URLSearchParams();
  for (const [key, value] of Object.entries(rawSearch)) {
    if (Array.isArray(value)) value.forEach((item) => sourceSearch.append(key, item));
    else if (value !== undefined) sourceSearch.set(key, value);
  }
  const library = await readResolvedLibraryState();
  const detailSource = library.document
    ? resolveMeetingDetailSource({
        meetingId: id,
        search: sourceSearch,
        document: library.document,
        placements: library.placements,
      })
    : null;
  const placement = library.placements.find((candidate) => candidate.meetingId === id);
  const attentionAfter = sourceSearch.get("attentionAfter");
  const publicStatus = toPublicMeeting(status);
  const contentOperation = publicStatus.contentOperation
    ?? (isExactMeetingOperationActive(id, "transcript_regenerate")
      ? "transcript"
      : isExactMeetingOperationActive(id, "summary_regenerate")
        ? "summary"
        : isExactMeetingOperationActive(id, "summarize")
          ? "initial"
          : null);
  const contentTab = sourceSearch.get("contentTab");

  return (
    <MeetingDetailView
      id={id}
      status={{ ...publicStatus, contentOperation }}
      transcript={transcript}
      segments={transcription.state === "complete" ? readSegments(p.segments) : []}
      summary={parsedSummary}
      content={{
        state: pair.state,
        revision: pair.revision ?? null,
        transcriptSource: pair.contentRevision?.transcript.source ?? null,
        summarySource: pair.contentRevision?.summary.source ?? null,
        summaryOutdated: pair.summaryOutdated ?? null,
      }}
      hasAudio={existsSync(p.play) || existsSync(p.audio)}
      // Unified inflight signal: the durable status.summarizeAttempt (same field the list
      // DTO reads) OR the in-process lock. Sharing summarizeAttempt keeps list and detail in
      // agreement even after a restart or orphaned lease, when the in-memory lock is gone but
      // the attempt persists until reconciliation clears it (R6).
      resummarizeInflight={contentOperation === "initial" || contentOperation === "summary"}
      initialTab={contentTab === "summary" ? "summary" : "script"}
      backHref={detailSource?.backHref ?? "/"}
      location={placement
        ? { workspaceId: placement.workspaceId, folderId: placement.folderId }
        : null}
      source={detailSource?.source}
      sourceAccepted={detailSource?.sourceAccepted ?? true}
      canonicalDetailHref={detailSource?.canonicalDetailHref}
      attentionAfter={attentionAfter}
    />
  );
}
