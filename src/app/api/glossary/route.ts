import { NextResponse } from "next/server";

import { glossarySchema } from "@/domain/glossary";
import { readGlossary, writeGlossary } from "@/lib/glossary";

// GET/POST /api/glossary — the domain glossary ({terms, corrections}). app-api is
// the single writer. POST replaces the whole glossary; the body is normalized by
// glossarySchema (trim/dedupe/cap) before it is written.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bound the request body before parsing (the schema already caps item counts, but
// this stops an oversized payload from being read/parsed at all).
const MAX_BODY_BYTES = 256 * 1024;

export async function GET() {
  return NextResponse.json(await readGlossary());
}

export async function POST(request: Request) {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "glossary too large" }, { status: 413 });
  }

  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "glossary too large" }, { status: 413 });
  }

  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  const parsed = glossarySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid glossary body" }, { status: 400 });
  }

  await writeGlossary(parsed.data);
  return NextResponse.json(parsed.data);
}
