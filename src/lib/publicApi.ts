import { z } from "zod";

import type {
  ErrorAction,
  MeetingStatus,
  StatusError,
  StatusJson,
} from "@/domain/meeting";
import type { LlmProvider } from "@/services/llm/types";

export type PublicErrorCode =
  | "invalid_host"
  | "cross_site_request"
  | "missing_origin"
  | "invalid_origin"
  | "unsupported_media_type"
  | "request_body_too_large"
  | "invalid_content_length"
  | "invalid_json"
  | "invalid_request"
  | "meeting_not_found"
  | "meeting_deleted"
  | "delete_state_ambiguous"
  | "meeting_conflict"
  | "library_revision_conflict"
  | "library_destination_conflict"
  | "folder_move_conflict"
  | "container_delete_conflict"
  | "fingerprint_changed"
  | "recovery_not_supported"
  | "recovery_conflict"
  | "recovery_io"
  | "content_revision_conflict"
  | "content_operation_in_progress"
  | "content_source_conflict"
  | "content_state_ambiguous"
  | "content_save_unavailable"
  | "chat_llm_unconfigured"
  | "chat_llm_unavailable"
  | "chat_timeout"
  | "chat_index_unavailable"
  | "summary_tool_missing"
  | "summary_timeout"
  | "summary_auth_required"
  | "summary_provider_failed"
  | "summary_failed"
  | "transcript_generation_failed"
  | "transcription_failed"
  | "local_service_unavailable"
  | "internal_error";

const PUBLIC_ERROR_MESSAGES: Record<PublicErrorCode, string> = {
  invalid_host: "로컬 앱 요청만 허용됩니다",
  cross_site_request: "다른 사이트에서 보낸 요청은 허용되지 않습니다",
  missing_origin: "요청 출처를 확인할 수 없습니다",
  invalid_origin: "요청 출처가 로컬 앱과 일치하지 않습니다",
  unsupported_media_type: "지원하지 않는 요청 형식입니다",
  request_body_too_large: "요청 데이터가 너무 큽니다",
  invalid_content_length: "요청 크기 정보가 올바르지 않습니다",
  invalid_json: "JSON 요청을 확인해 주세요",
  invalid_request: "요청 내용을 확인해 주세요",
  meeting_not_found: "회의를 찾을 수 없습니다",
  meeting_deleted: "삭제된 회의입니다",
  delete_state_ambiguous: "삭제 상태를 안전하게 확인할 수 없습니다",
  meeting_conflict: "현재 회의 상태에서는 요청을 처리할 수 없습니다",
  library_revision_conflict: "최신 상태를 확인한 뒤 다시 시도해 주세요",
  library_destination_conflict: "선택한 위치가 더 이상 존재하지 않습니다. 최신 위치를 다시 선택해 주세요",
  folder_move_conflict: "선택한 위치로 폴더를 이동할 수 없습니다",
  container_delete_conflict: "최신 조직 상태에서 이 컨테이너를 안전하게 삭제할 수 없습니다",
  fingerprint_changed: "조직 파일 상태가 변경되었습니다. 최신 상태를 확인해 주세요",
  recovery_not_supported: "이 환경에서는 조직 파일을 안전하게 복구할 수 없습니다",
  recovery_conflict: "조직 파일 복구 상태를 안전하게 확인할 수 없습니다",
  recovery_io: "조직 파일 복구 중 로컬 저장소 오류가 발생했습니다",
  content_revision_conflict: "다른 저장으로 회의 내용이 변경되었습니다. 최신 내용을 확인해 주세요",
  content_operation_in_progress: "다른 회의 내용 작업이 진행 중입니다. 완료된 뒤 다시 시도해 주세요",
  content_source_conflict: "저장된 회의 내용의 출처 정보를 안전하게 확인할 수 없습니다",
  content_state_ambiguous: "회의 내용 저장 상태를 안전하게 확인할 수 없습니다",
  content_save_unavailable: "회의 내용을 로컬 저장소에 안전하게 저장하거나 확인할 수 없습니다",
  chat_llm_unconfigured: "질문 기능을 사용하려면 요약 모델을 먼저 설정해 주세요",
  chat_llm_unavailable: "설정한 로컬 요약 모델을 사용할 수 없습니다. 설정과 로그인을 확인해 주세요",
  chat_timeout: "답변 준비 시간이 초과되었습니다. 다시 시도하거나 확인 범위를 줄여 주세요",
  chat_index_unavailable: "회의 검색 데이터를 사용할 수 없습니다. 검색 데이터를 다시 만들어 주세요",
  summary_tool_missing: "선택한 요약 도구를 찾을 수 없습니다. 설정을 확인해 주세요",
  summary_timeout: "요약 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요",
  summary_auth_required: "요약 도구 로그인이 필요합니다. 로그인한 뒤 다시 시도해 주세요",
  summary_provider_failed: "요약 도구가 작업을 완료하지 못했습니다. 설정을 확인해 주세요",
  summary_failed: "요약을 완료하지 못했습니다. 설정을 확인한 뒤 다시 시도해 주세요",
  transcript_generation_failed: "전체 스크립트를 다시 만들지 못했습니다. 설정을 확인한 뒤 다시 시도해 주세요",
  transcription_failed: "전사를 완료하지 못했습니다. 로컬 전사 서비스를 확인해 주세요",
  local_service_unavailable: "로컬 서비스를 사용할 수 없습니다",
  internal_error: "요청을 처리하지 못했습니다",
};

const SAFE_DETAIL_KEYS = new Set([
  "meetingId",
  "workspaceId",
  "folderId",
  "mode",
  "action",
  "field",
  "operation",
  "recoveryFingerprint",
]);
const SAFE_DETAIL_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

function allowlistedDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!SAFE_DETAIL_KEYS.has(key)) continue;
    if (typeof value === "string" && SAFE_DETAIL_VALUE.test(value)) safe[key] = value;
    else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
    else if (typeof value === "boolean") safe[key] = value;
    else if (value === null && key === "folderId") safe[key] = null;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export function jsonNoStore(payload: unknown, init: number | ResponseInit = 200): Response {
  const responseInit: ResponseInit = typeof init === "number" ? { status: init } : init;
  const headers = new Headers(responseInit.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(payload), { ...responseInit, headers });
}

export function publicErrorResponse(
  code: PublicErrorCode,
  status: number,
  details?: Record<string, unknown>,
): Response {
  return jsonNoStore(publicErrorPayload(code, details), status);
}

export function publicErrorPayload(
  code: PublicErrorCode,
  details?: Record<string, unknown>,
): { error: { code: PublicErrorCode; message: string; details?: Record<string, unknown> } } {
  const safeDetails = allowlistedDetails(details);
  return {
    error: {
      code,
      message: PUBLIC_ERROR_MESSAGES[code],
      ...(safeDetails ? { details: safeDetails } : {}),
    },
  };
}

export interface PublicStatusError {
  code: string;
  message: string;
  action: ErrorAction;
}

function publicStatusError(error: StatusError | null): PublicStatusError | null {
  if (!error) return null;
  if (error.action === "retry_transcript_generation") {
    return {
      code: "transcript_generation_failed",
      message: PUBLIC_ERROR_MESSAGES.transcript_generation_failed,
      action: error.action,
    };
  }
  if (error.action === "retry_summary") {
    const code = error.code && error.code in PUBLIC_ERROR_MESSAGES
      ? error.code as PublicErrorCode
      : "summary_failed";
    return { code, message: PUBLIC_ERROR_MESSAGES[code], action: error.action };
  }
  return {
    code: "transcription_failed",
    message: PUBLIC_ERROR_MESSAGES.transcription_failed,
    action: error.action,
  };
}

const publicMeetingSchema = z.object({
  id: z.string(),
  title: z.string(),
  titleOverride: z.string().optional(),
  status: z.string(),
  error: z.object({ code: z.string(), message: z.string(), action: z.string() }).nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number(),
  audioMime: z.string(),
  whisper: z.object({ progress: z.number() }),
  review: z.object({ participants: z.array(z.string()) }),
  contentOperation: z.enum(["initial", "transcript", "summary"]).nullable(),
  updatedAt: z.string(),
}).strict();

export type PublicContentOperation = "initial" | "transcript" | "summary";

export function contentOperationForStatus(
  status: StatusJson,
): PublicContentOperation | null {
  const kind = status.summarizeAttempt?.kind;
  if (kind === "initial") return "initial";
  if (kind === "transcript_regenerate") return "transcript";
  if (kind === "resummarize" || kind === "summary_regenerate") return "summary";
  return null;
}

export interface PublicMeeting {
  id: string;
  title: string;
  titleOverride?: string;
  status: MeetingStatus;
  error: PublicStatusError | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  audioMime: string;
  whisper: { progress: number };
  review: { participants: string[] };
  contentOperation?: PublicContentOperation | null;
  updatedAt: string;
}

export function toPublicMeeting(status: StatusJson): PublicMeeting {
  return publicMeetingSchema.parse({
    id: status.id,
    title: status.title,
    ...(status.titleOverride !== undefined ? { titleOverride: status.titleOverride } : {}),
    status: status.status,
    error: publicStatusError(status.error),
    startedAt: status.startedAt,
    endedAt: status.endedAt,
    durationMs: status.durationMs,
    audioMime: status.audioMime,
    whisper: { progress: status.whisper.progress },
    review: { participants: [...status.review.participants] },
    contentOperation: contentOperationForStatus(status),
    updatedAt: status.updatedAt,
  }) as PublicMeeting;
}

export interface PublicMeetingListItem {
  id: string;
  title: string;
  status: MeetingStatus;
  startedAt: string;
  error: PublicStatusError | null;
  // Durable content generation kind. `manual_edit` is intentionally null: a
  // save is not presented as transcript/summary generation.
  contentOperation?: PublicContentOperation | null;
  // Legacy summary-only compatibility signal. Transcript generation must not be
  // collapsed into this boolean; new consumers use contentOperation instead.
  resummarizeInflight?: boolean;
}

export function toPublicMeetingListItem(status: StatusJson): PublicMeetingListItem {
  const contentOperation = contentOperationForStatus(status);
  return {
    id: status.id,
    title: status.title,
    status: status.status,
    startedAt: status.startedAt,
    error: publicStatusError(status.error),
    contentOperation,
    resummarizeInflight: contentOperation === "initial" || contentOperation === "summary",
  };
}

export interface ClassifiedLlmFailure extends StatusError {
  code:
    | "summary_tool_missing"
    | "summary_timeout"
    | "summary_auth_required"
    | "summary_provider_failed";
}

export function classifyLlmFailure(
  error: unknown,
  provider?: LlmProvider,
): ClassifiedLlmFailure {
  void provider;
  const raw = error instanceof Error ? error.message : String(error ?? "");
  let code: ClassifiedLlmFailure["code"] = "summary_provider_failed";
  if (/\bENOENT\b|not found on PATH|command not found|spawn .* not found/iu.test(raw)) {
    code = "summary_tool_missing";
  } else if (/timed out|timeout|AbortError/iu.test(raw)) {
    code = "summary_timeout";
  } else if (/not logged in|please run \/login|auth(?:entication)? (?:required|failed)|unauthorized/iu.test(raw)) {
    code = "summary_auth_required";
  }
  return {
    code,
    message: PUBLIC_ERROR_MESSAGES[code],
    action: "retry_summary",
  };
}

export interface SafeLogEvent {
  level: "info" | "warn" | "error";
  code?: string;
  operation?: string;
  meetingId?: string;
  workspaceId?: string;
  folderId?: string;
  phase?: string;
  provider?: string;
}

const SAFE_LOG_KEYS = [
  "code",
  "operation",
  "meetingId",
  "workspaceId",
  "folderId",
  "phase",
  "provider",
] as const;

export function safeLog(
  level: SafeLogEvent["level"],
  fields: Record<string, unknown>,
  sink: (event: SafeLogEvent) => void = (event) => {
    if (event.level === "error") console.error(event);
    else if (event.level === "warn") console.warn(event);
    else console.info(event);
  },
): void {
  const event: SafeLogEvent = { level };
  for (const key of SAFE_LOG_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && SAFE_DETAIL_VALUE.test(value)) event[key] = value;
  }
  sink(event);
}
