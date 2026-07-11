import { z } from "zod";

import { LIBRARY_COLORS } from "@/domain/library";
import { editFolder } from "@/domain/libraryMutations";
import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import { runPublicLibraryMutation } from "@/lib/libraryHttp";
import { commitFolderContainerDelete } from "@/lib/libraryContainerDeleteService";
import { publicErrorResponse } from "@/lib/publicApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const editSchema = z.object({
  expectedLibraryId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().safe(),
  name: z.string().optional(),
  color: z.enum(LIBRARY_COLORS).optional(),
}).strict().refine((value) => value.name !== undefined || value.color !== undefined);

const deleteSchema = z.object({
  expectedLibraryId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().safe(),
}).strict();

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
  const parsed = editSchema.safeParse(body);
  if (!parsed.success) return publicErrorResponse("invalid_request", 400);
  return runPublicLibraryMutation({
    expected: {
      libraryId: parsed.data.expectedLibraryId,
      revision: parsed.data.expectedRevision,
    },
    reducer: (document) => editFolder(document, {
      folderId,
      name: parsed.data.name,
      color: parsed.data.color,
      now: new Date().toISOString(),
    }),
  });
}

export async function DELETE(
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
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) return publicErrorResponse("invalid_request", 400);
  return commitFolderContainerDelete(folderId, {
    libraryId: parsed.data.expectedLibraryId,
    revision: parsed.data.expectedRevision,
  });
}
