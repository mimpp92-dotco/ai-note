import { existsSync } from "node:fs";

import { z } from "zod";

import { acquireArtifactWriteLease } from "@/lib/artifactLease";
import {
  finalizeReceiptHash,
  FinalizeRecordError,
  inspectFinalizeRecord,
  prepareFinalizeRecord,
  publishPreparedFinalizeRecord,
  type FinalizeLocation,
  type FinalizeMetadata,
  type FinalizeReceipt,
} from "@/lib/finalizeRecord";
import {
  ensureFinalizePlacement,
  readMeetingLocation,
  type FinalizePlacementResult,
} from "@/lib/finalizePlacement";
import { remuxToPlay } from "@/lib/ffmpeg";
import { guardLocalApiRequest } from "@/lib/localRequestGuard";
import { meetingFenceResponse } from "@/lib/meetingFence";
import { tryAcquireMeetingOperation } from "@/lib/meetingLifecycle";
import { assertSafeId } from "@/lib/meetingId";
import { meetingPaths } from "@/lib/paths";
import { invalidateOrganizationPending } from "@/lib/organizationPending";
import { jsonNoStore, publicErrorResponse, safeLog } from "@/lib/publicApi";
import { readStatus, updateStatus } from "@/lib/status";
import { enqueueTranscription } from "@/lib/transcribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidSchema = z.string().uuid();
const startedAtSchema = z.string().datetime({ offset: true });
const ALLOWED_MIME_TYPES = new Set<FinalizeMetadata["mimeType"]>([
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/mp4",
]);
const ALLOWED_QUERY_KEYS = new Set([
  "durationMs",
  "mime",
  "startedAt",
  "workspaceId",
  "folderId",
  "probe",
]);

type ParsedFinalizeRequest = {
  metadata: FinalizeMetadata;
  requestedLocation?: FinalizeLocation;
  probe: boolean;
};

function parseFinalizeRequest(request: Request): ParsedFinalizeRequest | null {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key) || url.searchParams.getAll(key).length !== 1) return null;
  }
  const durationText = url.searchParams.get("durationMs");
  if (!durationText || !/^(?:0|[1-9][0-9]*)$/u.test(durationText)) return null;
  const durationMs = Number(durationText);
  if (!Number.isSafeInteger(durationMs)) return null;

  const queryMime = url.searchParams.get("mime");
  const headerMime = request.headers.get("content-type");
  if (queryMime && headerMime && queryMime !== headerMime) return null;
  const mimeType = queryMime ?? headerMime ?? "audio/webm;codecs=opus";
  if (!ALLOWED_MIME_TYPES.has(mimeType as FinalizeMetadata["mimeType"])) return null;

  const startedAtText = url.searchParams.get("startedAt")
    ?? new Date(Date.now() - durationMs).toISOString();
  const parsedStartedAt = startedAtSchema.safeParse(startedAtText);
  if (!parsedStartedAt.success) return null;

  const workspaceId = url.searchParams.get("workspaceId");
  const folderIdText = url.searchParams.get("folderId");
  if (folderIdText !== null && workspaceId === null) return null;
  let requestedLocation: FinalizeLocation | undefined;
  if (workspaceId !== null) {
    if (!uuidSchema.safeParse(workspaceId).success) return null;
    if (folderIdText !== null && !uuidSchema.safeParse(folderIdText).success) return null;
    requestedLocation = { workspaceId, folderId: folderIdText };
  }
  const probeText = url.searchParams.get("probe");
  if (probeText !== null && probeText !== "1") return null;
  return {
    metadata: {
      durationMs,
      startedAt: parsedStartedAt.data,
      mimeType: mimeType as FinalizeMetadata["mimeType"],
    },
    ...(requestedLocation ? { requestedLocation } : {}),
    probe: probeText === "1",
  };
}

async function ensurePlayback(
  id: string,
  ownerToken: string,
): Promise<"ready" | "failed" | "unchanged"> {
  const paths = meetingPaths(id);
  if (existsSync(paths.play)) return "unchanged";
  if (!existsSync(paths.audio)) return "failed";
  const lease = await acquireArtifactWriteLease(id, ownerToken);
  try {
    if (existsSync(paths.play)) return "unchanged";
    await remuxToPlay(paths.audio, paths.play);
    return "ready";
  } catch {
    return "failed";
  } finally {
    lease.release();
  }
}

async function resolvePlacement(
  id: string,
  receipt: FinalizeReceipt | null,
  ownerToken: string,
): Promise<FinalizePlacementResult> {
  if (receipt) {
    return ensureFinalizePlacement({
      meetingId: id,
      receipt,
      receiptHash: finalizeReceiptHash(receipt),
      ownerToken,
    });
  }
  const current = await readMeetingLocation(id);
  const actual = current.location
    ? { workspaceId: current.location.workspaceId, folderId: current.location.folderId }
    : null;
  return {
    requested: null,
    actual,
    outcome: actual ? "saved" : "unavailable",
    fallbackReason: null,
    version: current.version,
  };
}

async function ensureTranscription(
  id: string,
  ownerToken: string,
): Promise<"accepted" | "failed" | "unchanged"> {
  const before = await readStatus(id);
  if (!before) return "failed";
  if (
    before.transcriptionDispatch
    && ["accepted", "sent", "completed"].includes(before.transcriptionDispatch.state)
  ) return "unchanged";
  try {
    const result = await enqueueTranscription(id, { ownerToken });
    return result.ok ? "accepted" : "unchanged";
  } catch {
    try {
      await updateStatus(id, ownerToken, (latest) => ({
        ...latest,
        error: {
          code: "transcription_failed",
          message: "전사를 완료하지 못했습니다. 로컬 전사 서비스를 확인해 주세요",
          action: "retry_transcription",
        },
        ...(latest.transcriptionDispatch
          ? {
              transcriptionDispatch: {
                ...latest.transcriptionDispatch,
                state: "failed" as const,
              },
            }
          : {}),
      }));
    } catch {
      // The artifact is already published. A failed diagnostic status update
      // must not turn the finalize response into an upload retry signal.
    }
    return "failed";
  }
}

function finalizeErrorResponse(error: unknown, id: string): Response {
  if (error instanceof FinalizeRecordError) {
    if (error.code === "meeting_deleted") {
      return publicErrorResponse("meeting_deleted", 410, { meetingId: id });
    }
    if (error.code === "finalize_conflict" || error.code === "finalize_state_ambiguous") {
      return publicErrorResponse("meeting_conflict", 409, { meetingId: id });
    }
  }
  safeLog("error", { code: "finalize_failed", operation: "finalize", meetingId: id });
  return publicErrorResponse("internal_error", 500, { meetingId: id });
}

// The deterministic staging record and immutable receipt make this endpoint a
// same-ID finalize/probe operation. Once the final directory exists, replacement
// request bodies are never observed.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
  const parsed = parseFinalizeRequest(request);
  if (!parsed) return publicErrorResponse("invalid_request", 400);

  const operation = await tryAcquireMeetingOperation(id, "finalize");
  if (!operation) return publicErrorResponse("meeting_conflict", 409, { meetingId: id });
  try {
    if (parsed.probe) {
      const inspected = await inspectFinalizeRecord(id);
      if (inspected.state === "not_committed") {
        return jsonNoStore({ probe: "not_committed" });
      }
      if (inspected.state === "body_required") {
        return jsonNoStore({
          probe: "body_required",
          requestedLocation: inspected.intent.requestedLocation,
          locationSource: inspected.intent.locationSource,
        });
      }
    }
    const prepared = await prepareFinalizeRecord({
      id,
      metadata: parsed.metadata,
      requestedLocation: parsed.requestedLocation,
      ownerToken: operation.ownerToken,
    });
    let artifact: "published" | "already_published";
    let durability: "durable" | "best_effort" | "pending";
    let receipt: FinalizeReceipt | null;
    if (prepared.kind === "already_published") {
      artifact = "already_published";
      durability = prepared.durability;
      receipt = prepared.receipt;
    } else {
      const body = prepared.needsBody ? request.body : null;
      if (prepared.needsBody && !body) {
        return publicErrorResponse("invalid_request", 400, { field: "audio" });
      }
      const published = await publishPreparedFinalizeRecord({
        prepared,
        body,
        ownerToken: operation.ownerToken,
      });
      artifact = published.artifact;
      durability = published.durability;
      receipt = published.receipt;
      invalidateOrganizationPending();
    }

    const playback = await ensurePlayback(id, operation.ownerToken);
    let placement: FinalizePlacementResult;
    try {
      placement = await resolvePlacement(id, receipt, operation.ownerToken);
    } catch {
      placement = {
        requested: receipt?.requestedLocation ?? null,
        actual: null,
        outcome: "unavailable",
        fallbackReason: "library_degraded",
        version: null,
      };
    }
    const transcription = await ensureTranscription(id, operation.ownerToken);
    const status = await readStatus(id);
    return jsonNoStore({
      id,
      artifact,
      durability,
      playback,
      version: placement.version,
      placement: {
        requested: placement.requested,
        actual: placement.actual,
        outcome: placement.outcome,
        fallbackReason: placement.fallbackReason,
      },
      transcription,
      // Transition adapter for the pre-library recorder, which only relied on
      // the status field and HTTP success.
      status: status?.status ?? null,
      ...(parsed.probe ? { probe: "published" } : {}),
    });
  } catch (error) {
    return finalizeErrorResponse(error, id);
  } finally {
    operation.release();
  }
}
