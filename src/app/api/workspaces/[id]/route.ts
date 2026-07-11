import { z } from "zod";

import { renameWorkspace } from "@/domain/libraryMutations";
import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import { runPublicLibraryMutation } from "@/lib/libraryHttp";
import { commitWorkspaceContainerDelete } from "@/lib/libraryContainerDeleteService";
import { publicErrorResponse } from "@/lib/publicApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const editSchema = z.object({
  expectedLibraryId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().safe(),
  name: z.string(),
}).strict();

const deleteSchema = z.object({
  expectedLibraryId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().safe(),
  destinationWorkspaceId: z.string().uuid(),
}).strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  const workspaceId = (await params).id;
  if (!z.string().uuid().safeParse(workspaceId).success) {
    return publicErrorResponse("invalid_request", 400, { field: "workspaceId" });
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
    reducer: (document) => renameWorkspace(document, {
      workspaceId,
      name: parsed.data.name,
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
  const workspaceId = (await params).id;
  if (!z.string().uuid().safeParse(workspaceId).success) {
    return publicErrorResponse("invalid_request", 400, { field: "workspaceId" });
  }
  let body: unknown;
  try {
    body = await parseBoundedJsonBody(request, 8 * 1024);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) return publicErrorResponse("invalid_request", 400);
  return commitWorkspaceContainerDelete(
    workspaceId,
    parsed.data.destinationWorkspaceId,
    {
      libraryId: parsed.data.expectedLibraryId,
      revision: parsed.data.expectedRevision,
    },
  );
}
