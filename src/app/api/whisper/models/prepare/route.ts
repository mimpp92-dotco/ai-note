import { z } from "zod";

import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import { WHISPER_MODELS } from "@/lib/pipelineSettings";
import { jsonNoStore, publicErrorResponse } from "@/lib/publicApi";
import { prepareWhisperModel } from "@/services/whisperClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const prepareSchema = z.object({
  model: z.enum(WHISPER_MODELS),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await parseBoundedJsonBody(request, 4 * 1024);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  const parsed = prepareSchema.safeParse(body);
  if (!parsed.success) return publicErrorResponse("invalid_request", 400);

  try {
    const result = await prepareWhisperModel(parsed.data.model);
    return jsonNoStore(result, result.status === "preparing" ? 202 : 200);
  } catch {
    return publicErrorResponse("local_service_unavailable", 503);
  }
}
