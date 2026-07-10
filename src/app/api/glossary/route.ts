import { glossarySchema } from "@/domain/glossary";
import { readGlossary, writeGlossary } from "@/lib/glossary";
import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import { jsonNoStore, publicErrorResponse } from "@/lib/publicApi";

// GET/POST /api/glossary — the domain glossary ({terms, corrections}). app-api is
// the single writer. POST replaces the whole glossary; the body is normalized by
// glossarySchema (trim/dedupe/cap) before it is written.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bound the request body before parsing (the schema already caps item counts, but
// this stops an oversized payload from being read/parsed at all).
const MAX_BODY_BYTES = 256 * 1024;

export async function GET(request: Request) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  return jsonNoStore(await readGlossary());
}

export async function POST(request: Request) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await parseBoundedJsonBody(request, MAX_BODY_BYTES);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }

  const parsed = glossarySchema.safeParse(body);
  if (!parsed.success) {
    return publicErrorResponse("invalid_request", 400);
  }

  await writeGlossary(parsed.data);
  return jsonNoStore(parsed.data);
}
