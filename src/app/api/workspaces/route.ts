import { randomUUID } from "node:crypto";

import { z } from "zod";

import { createWorkspace } from "@/domain/libraryMutations";
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
  name: z.string(),
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
    reducer: (document) => createWorkspace(document, {
      id: randomUUID(),
      name: parsed.data.name,
      now: new Date().toISOString(),
    }),
  });
}
