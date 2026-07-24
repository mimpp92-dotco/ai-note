import { z } from "zod";

import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import {
  normalizeLoopbackHttpBaseUrl,
  UnsafeLocalEndpointError,
} from "@/lib/localEndpoint";
import { jsonNoStore, publicErrorResponse } from "@/lib/publicApi";
import { discoverOllamaModels } from "@/services/llm/ollama";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const discoverySchema = z.object({
  baseUrl: z.string().min(1).max(512).optional(),
}).strict();

export async function POST(request: Request) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await parseBoundedJsonBody(request, 4 * 1024);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  const parsed = discoverySchema.safeParse(body);
  if (!parsed.success) return publicErrorResponse("invalid_request", 400);

  let baseUrl: string;
  try {
    baseUrl = normalizeLoopbackHttpBaseUrl(
      parsed.data.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
    );
  } catch (error) {
    if (error instanceof UnsafeLocalEndpointError) {
      return publicErrorResponse("invalid_request", 400, { field: "baseUrl" });
    }
    return publicErrorResponse("invalid_request", 400);
  }

  try {
    const models = await discoverOllamaModels(baseUrl);
    return jsonNoStore({ models });
  } catch {
    return publicErrorResponse("local_service_unavailable", 503);
  }
}
