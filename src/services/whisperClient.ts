import { localSttBaseUrl } from "@/lib/config";
import { isSafeId } from "@/lib/meetingId";
import {
  isWhisperModel,
  type WhisperModel,
} from "@/lib/pipelineSettings";

export type WhisperModelPreparationStatus = "idle" | "preparing" | "ready" | "error";

export interface WhisperModelPreparation {
  model: WhisperModel;
  status: WhisperModelPreparationStatus;
}

export interface WhisperHealth {
  ok: boolean;
  model: string;
  ready: boolean;
  message?: string;
  modelPreparation?: WhisperModelPreparation[];
}

export interface WhisperJob {
  status: "processing" | "done" | "error";
  progress: number;
  error?: "transcription_failed" | "durability_pending";
}

export interface EnqueueArgs {
  meetingId: string;
  dispatchId: string;
}

export interface EnqueueResponse {
  dispatchId: string;
  status: "accepted" | "processing" | "done";
  legacy?: boolean;
}

export type WhisperDispatchProposal =
  | EnqueueResponse
  | { dispatchId: string; status: "adopt" };

export interface WhisperPrepareResponse {
  model: WhisperModel;
  status: "preparing" | "ready";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class WhisperProtocolError extends Error {
  readonly code: "invalid_whisper_protocol" | "whisper_unavailable";

  constructor(code: WhisperProtocolError["code"]) {
    super(code);
    this.name = "WhisperProtocolError";
    this.code = code;
  }
}

function assertProtocolIds(meetingId: string, dispatchId: string): void {
  if (!isSafeId(meetingId) || !UUID.test(dispatchId)) {
    throw new WhisperProtocolError("invalid_whisper_protocol");
  }
}

async function safeJson(response: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function parseModelPreparation(value: unknown): WhisperModelPreparation[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2) {
    throw new WhisperProtocolError("whisper_unavailable");
  }
  const seen = new Set<WhisperModel>();
  const parsed: WhisperModelPreparation[] = [];
  for (const item of value) {
    if (
      typeof item !== "object"
      || item === null
      || Array.isArray(item)
      || !exactKeys(item as Record<string, unknown>, ["model", "status"])
    ) {
      throw new WhisperProtocolError("whisper_unavailable");
    }
    const model = (item as { model?: unknown }).model;
    const status = (item as { status?: unknown }).status;
    if (
      !isWhisperModel(model)
      || seen.has(model)
      || (
        status !== "idle"
        && status !== "preparing"
        && status !== "ready"
        && status !== "error"
      )
    ) {
      throw new WhisperProtocolError("whisper_unavailable");
    }
    seen.add(model);
    parsed.push({ model, status });
  }
  return parsed;
}

export async function fetchWhisperHealth(): Promise<WhisperHealth> {
  const response = await fetch(`${localSttBaseUrl()}/health`, {
    headers: { "X-AI-Note-Service": "app-api-v1" },
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new WhisperProtocolError("whisper_unavailable");
  const value = await safeJson(response);
  if (
    typeof value.ok !== "boolean"
    || typeof value.model !== "string"
    || value.model.length === 0
    || value.model.length > 128
    || typeof value.ready !== "boolean"
    || (
      value.message !== undefined
      && (typeof value.message !== "string" || value.message.length > 512)
    )
  ) {
    throw new WhisperProtocolError("whisper_unavailable");
  }
  const modelPreparation = parseModelPreparation(value.modelPreparation);
  return {
    ok: value.ok,
    model: value.model,
    ready: value.ready,
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(modelPreparation ? { modelPreparation } : {}),
  };
}

export async function prepareWhisperModel(model: WhisperModel): Promise<WhisperPrepareResponse> {
  if (!isWhisperModel(model)) {
    throw new WhisperProtocolError("invalid_whisper_protocol");
  }
  const response = await fetch(`${localSttBaseUrl()}/models/prepare`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AI-Note-Service": "app-api-v1",
    },
    body: JSON.stringify({ model }),
    cache: "no-store",
    redirect: "error",
  });
  if (response.status !== 200 && response.status !== 202) {
    throw new WhisperProtocolError("whisper_unavailable");
  }
  const value = await safeJson(response);
  if (
    !exactKeys(value, ["model", "status"])
    || !isWhisperModel(value.model)
    || value.model !== model
    || (value.status !== "preparing" && value.status !== "ready")
    || (response.status === 200 && value.status !== "ready")
    || (response.status === 202 && value.status !== "preparing")
  ) {
    throw new WhisperProtocolError("whisper_unavailable");
  }
  return { model: value.model, status: value.status };
}

async function postDispatch(args: EnqueueArgs): Promise<{
  response: Response;
  payload: Record<string, unknown>;
}> {
  const response = await fetch(`${localSttBaseUrl()}/transcribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AI-Note-Service": "app-api-v1",
    },
    body: JSON.stringify(args),
    cache: "no-store",
    redirect: "error",
  });
  return { response, payload: await safeJson(response) };
}

function parseEnqueueSuccess(
  response: Response,
  payload: Record<string, unknown>,
): EnqueueResponse {
  if (response.status !== 200 && response.status !== 202) {
    throw new WhisperProtocolError("whisper_unavailable");
  }
  if (
    typeof payload.dispatchId !== "string"
    || !UUID.test(payload.dispatchId)
    || (payload.status !== "accepted" && payload.status !== "processing" && payload.status !== "done")
  ) {
    throw new WhisperProtocolError("whisper_unavailable");
  }
  return {
    dispatchId: payload.dispatchId,
    status: payload.status,
    ...(payload.legacy === true ? { legacy: true } : {}),
  };
}

export async function enqueueWhisperJob(args: EnqueueArgs): Promise<EnqueueResponse> {
  const first = await proposeWhisperJob(args);
  if (first.status === "adopt") {
    const adopted = await proposeWhisperJob({ meetingId: args.meetingId, dispatchId: first.dispatchId });
    if (adopted.status === "adopt") throw new WhisperProtocolError("whisper_unavailable");
    return adopted;
  }
  return first;
}

export async function proposeWhisperJob(args: EnqueueArgs): Promise<WhisperDispatchProposal> {
  assertProtocolIds(args.meetingId, args.dispatchId);
  const first = await postDispatch(args);
  const error = first.payload.error;
  const errorCode = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (
    first.response.status === 409
    && errorCode === "adopt_existing_dispatch"
    && typeof first.payload.dispatchId === "string"
    && UUID.test(first.payload.dispatchId)
  ) {
    return { dispatchId: first.payload.dispatchId, status: "adopt" };
  }
  return parseEnqueueSuccess(first.response, first.payload);
}

export async function fetchWhisperJob(meetingId: string, dispatchId: string): Promise<WhisperJob> {
  assertProtocolIds(meetingId, dispatchId);
  const response = await fetch(`${localSttBaseUrl()}/jobs/${meetingId}/${dispatchId}`, {
    headers: { "X-AI-Note-Service": "app-api-v1" },
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new WhisperProtocolError("whisper_unavailable");
  const value = await safeJson(response);
  if (
    value.status !== "processing"
    && value.status !== "done"
    && value.status !== "error"
  ) {
    throw new WhisperProtocolError("whisper_unavailable");
  }
  const progress = typeof value.progress === "number" && Number.isFinite(value.progress)
    ? Math.max(0, Math.min(1, value.progress))
    : 0;
  return {
    status: value.status,
    progress,
    ...(value.status === "error"
      ? { error: value.error === "durability_pending" ? "durability_pending" : "transcription_failed" }
      : {}),
  };
}
