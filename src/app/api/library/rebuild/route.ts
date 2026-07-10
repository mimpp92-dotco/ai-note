import { z } from "zod";

import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import {
  createLibraryRecoveryExecutor,
  type LibraryRecoveryResult,
} from "@/lib/libraryRecoveryExecutor";
import {
  readResolvedLibraryState,
} from "@/lib/libraryService";
import { dataRoot } from "@/lib/paths";
import {
  jsonNoStore,
  publicErrorPayload,
  publicErrorResponse,
  type PublicErrorCode,
} from "@/lib/publicApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const rebuildSchema = z.object({
  expectedMode: z.literal("corrupt"),
  recoveryFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

function failureResponse(
  code: PublicErrorCode,
  status: number,
  result?: LibraryRecoveryResult,
): Response {
  const safeState = result?.state === "fingerprint_changed"
    ? {
        mode: "degraded_fallback",
        version: null,
        library: null,
        ...(result.currentMode === "corrupt"
          ? {
              degradedReason: "corrupt",
              ...(result.fingerprint
                ? { recovery: { canRebuild: true, fingerprint: result.fingerprint } }
                : {}),
            }
          : result.currentMode === "unsupported_version"
            ? { degradedReason: "unsupported_version" }
            : {}),
      }
    : {};
  return jsonNoStore({
    ...publicErrorPayload(code),
    ...safeState,
  }, status);
}

export async function POST(request: Request) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await parseBoundedJsonBody(request, 4 * 1024);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  const parsed = rebuildSchema.safeParse(body);
  if (!parsed.success) return publicErrorResponse("invalid_request", 400);

  const result = await createLibraryRecoveryExecutor({ dataRoot: dataRoot() }).rebuild({
    fingerprint: parsed.data.recoveryFingerprint,
  });
  if (result.state === "ready") {
    const state = await readResolvedLibraryState();
    if (
      state.mode !== "ready"
      || !state.library
      || state.version?.libraryId !== result.version.libraryId
      || state.version.revision !== result.version.revision
    ) return failureResponse("recovery_io", 503);
    return jsonNoStore({
      mode: "ready",
      version: result.version,
      defaultWorkspaceId: state.library.defaultWorkspaceId,
      result: {
        discoveredVisibleMeetingCount: result.discoveredVisibleMeetingCount,
        organizationReset: result.organizationReset,
        archivePreserved: result.archivePreserved,
      },
    });
  }
  if (
    result.state === "fingerprint_changed"
    || result.state === "missing"
    || result.state === "unsupported_version"
    || result.state === "corrupt"
  ) {
    return failureResponse("fingerprint_changed", 409, result);
  }
  if (result.state === "recovery_conflict") {
    return failureResponse("recovery_conflict", 409);
  }
  if (result.state === "recovery_not_supported") {
    return failureResponse("recovery_not_supported", 503);
  }
  return failureResponse("recovery_io", 503);
}
