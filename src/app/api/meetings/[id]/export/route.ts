import { summarySchema } from "@/domain/summarySchema";
import { readArtifactPair } from "@/lib/artifactPair";
import { guardLocalApiRequest } from "@/lib/localRequestGuard";
import { meetingFenceResponse } from "@/lib/meetingFence";
import { assertSafeId } from "@/lib/meetingId";
import { publicErrorResponse } from "@/lib/publicApi";
import { readStatus } from "@/lib/status";
import { formatMeetingMarkdown } from "@/lib/summaryMarkdown";

// GET /api/meetings/[id]/export?fmt=md|json — download the finished meeting for
// hand-off. `md` = summary + full transcript (the human doc); `json` = the raw
// summary contract. Filename uses the safe id, never the title (title could carry
// characters that break the Content-Disposition header / enable injection).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  let id: string;
  try {
    id = assertSafeId((await params).id);
  } catch {
    return publicErrorResponse("invalid_request", 400, { field: "meetingId" });
  }
  const fenced = await meetingFenceResponse(id);
  if (fenced) return fenced;

  const pair = await readArtifactPair(id);
  const refenced = await meetingFenceResponse(id);
  if (refenced) return refenced;
  if (pair.state === "ambiguous") {
    return publicErrorResponse("summary_failed", 409, { meetingId: id, action: "reveal" });
  }
  if (pair.summary === null) {
    return publicErrorResponse("meeting_not_found", 404, { meetingId: id });
  }
  const summary = summarySchema.parse(JSON.parse(pair.summary));

  const fmt = new URL(request.url).searchParams.get("fmt") ?? "md";

  if (fmt === "json") {
    // json stays the raw summary contract (summary.json verbatim) — the manual
    // titleOverride is a display-layer concern and is NOT overlaid here. Only the
    // human-facing md gets the effective title (below).
    return new Response(JSON.stringify(summary, null, 2) + "\n", {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${id}.json"`,
        "cache-control": "no-store",
      },
    });
  }

  const transcript = pair.transcript ?? "";
  const status = await readStatus(id);
  // md is the human hand-off doc, so its H1 reflects the effective title, matching
  // deriveStatus display semantics: a user override wins, else the summarizer's
  // title. (status.title is only a mirror of summary.title and is NOT reconciled
  // on this path — e.g. worker/manual-skill summaries leave it at the auto
  // placeholder — so it must not sit between the two.)
  const effectiveTitle = status?.titleOverride ?? summary.title;
  const md = formatMeetingMarkdown(
    { ...summary, title: effectiveTitle },
    transcript,
    status?.review.participants ?? [],
  );

  return new Response(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${id}.md"`,
      "cache-control": "no-store",
    },
  });
}
