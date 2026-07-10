import { randomUUID } from "node:crypto";

import { z } from "zod";

import { LIBRARY_COLORS } from "@/domain/library";
import { createFolder } from "@/domain/libraryMutations";
import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import { runPublicLibraryMutation } from "@/lib/libraryHttp";
import { publicErrorResponse } from "@/lib/publicApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  expectedLibraryId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().safe(),
  workspaceId: z.string().uuid(),
  parentFolderId: z.string().uuid().nullable().default(null),
  name: z.string(),
  color: z.enum(LIBRARY_COLORS).optional(),
}).strict();

export async function POST(request: Request) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await parseBoundedJsonBody(request, 8 * 1024);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return publicErrorResponse("invalid_request", 400);
  return runPublicLibraryMutation({
    expected: {
      libraryId: parsed.data.expectedLibraryId,
      revision: parsed.data.expectedRevision,
    },
    reducer: (document) => createFolder(document, {
      id: randomUUID(),
      workspaceId: parsed.data.workspaceId,
      parentFolderId: parsed.data.parentFolderId,
      name: parsed.data.name,
      color: parsed.data.color,
      now: new Date().toISOString(),
    }),
  });
}
