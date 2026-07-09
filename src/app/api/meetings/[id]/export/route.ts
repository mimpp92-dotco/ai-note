import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { NextResponse } from "next/server";

import { summarySchema } from "@/domain/summarySchema";
import { assertSafeId } from "@/lib/meetingId";
import { meetingPaths } from "@/lib/paths";
import { readStatus } from "@/lib/status";
import { formatMeetingMarkdown } from "@/lib/summaryMarkdown";

// GET /api/meetings/[id]/export?fmt=md|json — download the finished meeting for
// hand-off. `md` = summary + full transcript (the human doc); `json` = the raw
// summary contract. Filename uses the safe id, never the title (title could carry
// characters that break the Content-Disposition header / enable injection).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let id: string;
  try {
    id = assertSafeId((await params).id);
  } catch {
    return NextResponse.json({ error: "invalid meeting id" }, { status: 400 });
  }

  const p = meetingPaths(id);
  if (!existsSync(p.summary)) {
    return NextResponse.json({ error: "not summarized" }, { status: 404 });
  }
  const summary = summarySchema.parse(JSON.parse(await readFile(p.summary, "utf-8")));

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

  const transcript = existsSync(p.transcript) ? await readFile(p.transcript, "utf-8") : "";
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
