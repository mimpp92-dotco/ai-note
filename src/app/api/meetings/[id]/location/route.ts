import { z } from "zod";

import type { ClassifiedMeetingRecord } from "@/domain/library";
import { moveMeetingPlacement, LibraryMutationError } from "@/domain/libraryMutations";
import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import { meetingFenceResponse } from "@/lib/meetingFence";
import { readMeetingLocation } from "@/lib/finalizePlacement";
import { LibraryRepositoryError } from "@/lib/library";
import {
  readResolvedLibraryState,
  toPublicLibraryResponse,
} from "@/lib/libraryService";
import { tryAcquireMeetingOperation } from "@/lib/meetingLifecycle";
import { assertSafeId } from "@/lib/meetingId";
import { invalidateOrganizationPending } from "@/lib/organizationPending";
import {
  jsonNoStore,
  publicErrorPayload,
  publicErrorResponse,
} from "@/lib/publicApi";
import { readStatus, updateStatus } from "@/lib/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const moveSchema = z.object({
  expectedLibraryId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().safe(),
  workspaceId: z.string().uuid(),
  folderId: z.string().uuid().nullable(),
}).strict();

class MeetingMoveRecordError extends Error {}

function deferUnresolved(record: ClassifiedMeetingRecord): "materialize" | "defer" {
  const resolution = record.status?.placementResolution?.state;
  return resolution === "pending" || resolution === "unavailable" ? "defer" : "materialize";
}

async function authoritativeConflict(
  code: "library_revision_conflict" | "library_destination_conflict",
): Promise<Response> {
  const current = await readResolvedLibraryState();
  return jsonNoStore({ ...publicErrorPayload(code), ...toPublicLibraryResponse(current) }, 409);
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
  if (!await readStatus(id)) {
    return publicErrorResponse("meeting_not_found", 404, { meetingId: id });
  }
  const result = await readMeetingLocation(id);
  return jsonNoStore({
    id,
    mode: result.mode,
    version: result.version,
    location: result.location,
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
  let body: unknown;
  try {
    body = await parseBoundedJsonBody(request, 8 * 1024);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  const parsed = moveSchema.safeParse(body);
  if (!parsed.success) return publicErrorResponse("invalid_request", 400);

  const operation = await tryAcquireMeetingOperation(id, "move");
  if (!operation) return publicErrorResponse("meeting_conflict", 409, { meetingId: id });
  try {
    const state = await readResolvedLibraryState();
    if (state.mode !== "ready") {
      return jsonNoStore({
        ...publicErrorPayload("internal_error"),
        ...toPublicLibraryResponse(state),
      }, 503);
    }
    try {
      await state.repository.transact({
        expected: {
          libraryId: parsed.data.expectedLibraryId,
          revision: parsed.data.expectedRevision,
        },
        placementPolicy: deferUnresolved,
        validate: (_document, scan) => {
          const record = scan.records.find((candidate) => candidate.meetingId === id);
          if (!record || record.kind !== "live") throw new MeetingMoveRecordError();
        },
        reducer: (document) => moveMeetingPlacement(document, {
          meetingId: id,
          workspaceId: parsed.data.workspaceId,
          folderId: parsed.data.folderId,
        }),
      });
    } catch (error) {
      if (error instanceof LibraryRepositoryError && error.code === "version_conflict") {
        return authoritativeConflict("library_revision_conflict");
      }
      if (error instanceof LibraryMutationError && (
        error.code === "workspace_not_found" || error.code === "folder_not_found"
      )) {
        return authoritativeConflict("library_destination_conflict");
      }
      if (error instanceof MeetingMoveRecordError) {
        return publicErrorResponse("meeting_not_found", 404, { meetingId: id });
      }
      if (error instanceof LibraryRepositoryError && error.code === "durability_pending") {
        return publicErrorResponse("internal_error", 503);
      }
      return publicErrorResponse("invalid_request", 400);
    }

    try {
      await updateStatus(id, operation.ownerToken, (latest) => {
        const resolution = latest.placementResolution;
        if (!resolution || resolution.state === "resolved") return latest;
        return {
          ...latest,
          placementResolution: { ...resolution, state: "resolved" as const },
        };
      });
    } catch {
      // The library placement is authoritative. A later finalize probe accepts
      // the existing placement and completes this advisory status transition.
    }
    invalidateOrganizationPending();
    const current = await readResolvedLibraryState();
    const location = await readMeetingLocation(id);
    return jsonNoStore({
      ...toPublicLibraryResponse(current),
      location: location.location,
    });
  } finally {
    operation.release();
  }
}
