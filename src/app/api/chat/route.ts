import { chatRequestSchema, chatResponseSchema } from "@/domain/chat";
import { ChatOrchestratorError, runChat } from "@/lib/chatOrchestrator";
import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import {
  jsonNoStore,
  publicErrorResponse,
  safeLog,
  type PublicErrorCode,
} from "@/lib/publicApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CHAT_BODY_BYTES = 128 * 1024;

const CHAT_ERROR_STATUS: Record<
  ChatOrchestratorError["code"],
  { code: PublicErrorCode; status: number }
> = {
  chat_llm_unconfigured: { code: "chat_llm_unconfigured", status: 409 },
  chat_llm_unavailable: { code: "chat_llm_unavailable", status: 503 },
  chat_timeout: { code: "chat_timeout", status: 504 },
  chat_index_unavailable: { code: "chat_index_unavailable", status: 503 },
};

export async function POST(request: Request): Promise<Response> {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await parseBoundedJsonBody(request, MAX_CHAT_BODY_BYTES);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  const parsed = chatRequestSchema.safeParse(raw);
  if (!parsed.success) return publicErrorResponse("invalid_request", 400);

  try {
    const result = await runChat(parsed.data);
    const safe = chatResponseSchema.safeParse(result);
    if (!safe.success) {
      safeLog("warn", { code: "chat_invalid_public_result", operation: "chat" });
      return publicErrorResponse("internal_error", 500);
    }
    return jsonNoStore(safe.data);
  } catch (error) {
    if (error instanceof ChatOrchestratorError) {
      const mapped = CHAT_ERROR_STATUS[error.code];
      safeLog("warn", { code: mapped.code, operation: "chat" });
      return publicErrorResponse(mapped.code, mapped.status);
    }
    safeLog("warn", { code: "chat_failed", operation: "chat" });
    return publicErrorResponse("internal_error", 500);
  }
}
