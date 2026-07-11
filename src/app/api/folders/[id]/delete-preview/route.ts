import { z } from "zod";

import { previewFolderContainerDelete } from "@/lib/libraryContainerDeleteService";
import { guardLocalApiRequest } from "@/lib/localRequestGuard";
import { publicErrorResponse } from "@/lib/publicApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  const folderId = (await params).id;
  if (!z.string().uuid().safeParse(folderId).success) {
    return publicErrorResponse("invalid_request", 400, { field: "folderId" });
  }
  return previewFolderContainerDelete(folderId);
}
