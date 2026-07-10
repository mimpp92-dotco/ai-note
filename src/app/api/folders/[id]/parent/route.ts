import { z } from "zod";

import { LibraryMutationError, reparentFolder } from "@/domain/libraryMutations";
import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import { LibraryRepositoryError } from "@/lib/library";
import { authoritativeLibraryResponse } from "@/lib/libraryHttp";
import {
  readResolvedLibraryState,
  toPublicLibraryResponse,
} from "@/lib/libraryService";
import {
  jsonNoStore,
  publicErrorPayload,
  publicErrorResponse,
} from "@/lib/publicApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const parentSchema = z.object({
  expectedLibraryId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().safe(),
  parentFolderId: z.string().uuid().nullable(),
}).strict();

async function authoritativeConflict(
  code: "library_revision_conflict" | "folder_move_conflict",
): Promise<Response> {
  const current = await readResolvedLibraryState();
  return jsonNoStore({ ...publicErrorPayload(code), ...toPublicLibraryResponse(current) }, 409);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  const folderId = (await params).id;
  if (!z.string().uuid().safeParse(folderId).success) {
    return publicErrorResponse("invalid_request", 400, { field: "folderId" });
  }
  let body: unknown;
  try {
    body = await parseBoundedJsonBody(request, 8 * 1024);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  const parsed = parentSchema.safeParse(body);
  if (!parsed.success) return publicErrorResponse("invalid_request", 400);

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
      reducer: (document) => reparentFolder(document, {
        folderId,
        parentFolderId: parsed.data.parentFolderId,
        now: new Date().toISOString(),
      }),
    });
  } catch (error) {
    if (error instanceof LibraryRepositoryError && error.code === "version_conflict") {
      return authoritativeConflict("library_revision_conflict");
    }
    if (error instanceof LibraryMutationError) {
      return authoritativeConflict("folder_move_conflict");
    }
    if (error instanceof LibraryRepositoryError && error.code === "durability_pending") {
      return publicErrorResponse("internal_error", 503);
    }
    return publicErrorResponse("invalid_request", 400);
  }
  return authoritativeLibraryResponse();
}
