import { z } from "zod";

import {
  createKnowledgeIndexRepository,
  type KnowledgeReindexResult,
} from "@/lib/knowledgeIndexRepository";
import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import { isSafeId } from "@/lib/meetingId";
import { dataRoot } from "@/lib/paths";
import { jsonNoStore, publicErrorResponse, safeLog } from "@/lib/publicApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reindexSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("all") }).strict(),
  z.object({
    scope: z.literal("meeting"),
    meetingId: z.string().refine(isSafeId),
  }).strict(),
]);

function unavailableResult(total: number): KnowledgeReindexResult {
  return {
    status: "unavailable",
    reasons: ["io_error"],
    count: { total, indexed: 0, skipped: total },
    durability: null,
  };
}

export async function POST(request: Request): Promise<Response> {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await parseBoundedJsonBody(request, 8 * 1024);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  const parsed = reindexSchema.safeParse(body);
  if (!parsed.success) return publicErrorResponse("invalid_request", 400);

  try {
    const repository = createKnowledgeIndexRepository({ dataRoot: dataRoot() });
    return jsonNoStore(await repository.reindex(parsed.data));
  } catch {
    safeLog("warn", {
      code: "knowledge_reindex_failed",
      operation: "knowledge_reindex",
      ...(parsed.data.scope === "meeting" ? { meetingId: parsed.data.meetingId } : {}),
    });
    return jsonNoStore(unavailableResult(parsed.data.scope === "meeting" ? 1 : 0));
  }
}
