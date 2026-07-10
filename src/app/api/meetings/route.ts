import { guardLocalApiRequest } from "@/lib/localRequestGuard";
import {
  LibraryQueryError,
  paginateGlobalFallbackMeetings,
  paginateLibraryMeetings,
  type LibraryMeetingScope,
} from "@/lib/libraryQuery";
import { readResolvedLibraryState } from "@/lib/libraryService";
import { jsonNoStore, publicErrorResponse, toPublicMeetingListItem } from "@/lib/publicApi";

// GET /api/meetings — list every meeting's status, newest first. Status is
// file-derived (deriveStatus) so the home banner sees transcribed/summarized even
// if status.json lags; this is a read-only view and does not persist.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const state = await readResolvedLibraryState();
  if ([...url.searchParams.keys()].length === 0) {
    return publicErrorResponse("invalid_request", 400, { field: "scope" });
  }

  const allowed = new Set(["workspaceId", "folderId", "view", "cursor", "limit"]);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) {
    return publicErrorResponse("invalid_request", 400);
  }
  const workspaceId = url.searchParams.get("workspaceId");
  const folderId = url.searchParams.get("folderId");
  const view = url.searchParams.get("view");
  const limitText = url.searchParams.get("limit");
  if (limitText !== null && !/^[1-9][0-9]*$/u.test(limitText)) {
    return publicErrorResponse("invalid_request", 400, { field: "limit" });
  }
  if (view === "global" && workspaceId === null && folderId === null) {
    try {
      const page = state.document
        ? paginateLibraryMeetings({
            document: state.document,
            records: state.records,
            placements: state.placements,
            scope: { kind: "global" },
            cursor: url.searchParams.get("cursor"),
            limit: limitText === null ? undefined : Number(limitText),
          })
        : paginateGlobalFallbackMeetings({
            records: state.records,
            cursor: url.searchParams.get("cursor"),
            limit: limitText === null ? undefined : Number(limitText),
          });
      return jsonNoStore({
        mode: state.mode,
        version: state.version,
        meetings: page.meetings,
        nextCursor: page.nextCursor,
      });
    } catch {
      return publicErrorResponse("invalid_request", 400, { field: "cursor" });
    }
  }
  if (!workspaceId || (folderId !== null && view !== null) || (view !== null && view !== "unfiled")) {
    return publicErrorResponse("invalid_request", 400);
  }
  const scope: LibraryMeetingScope = folderId
    ? { kind: "folder", workspaceId, folderId }
    : view === "unfiled"
      ? { kind: "unfiled", workspaceId }
      : { kind: "workspace", workspaceId };
  if (!state.document) {
    const meetings = state.records
      .filter((record) => record.kind === "live" && record.status !== null)
      .slice(0, Math.min(100, Number(limitText ?? 50)))
      .map((record) => toPublicMeetingListItem(record.status!));
    return jsonNoStore({ mode: state.mode, version: null, meetings, nextCursor: null });
  }
  try {
    const page = paginateLibraryMeetings({
      document: state.document,
      records: state.records,
      placements: state.placements,
      scope,
      cursor: url.searchParams.get("cursor"),
      limit: limitText === null ? undefined : Number(limitText),
    });
    return jsonNoStore({
      mode: state.mode,
      version: state.version,
      meetings: page.meetings,
      nextCursor: page.nextCursor,
    });
  } catch (error) {
    if (error instanceof LibraryQueryError && error.code === "stale_meeting_cursor") {
      return jsonNoStore({
        error: {
          code: "stale_meeting_cursor",
          message: "목록이 변경되었습니다. 처음부터 다시 불러와 주세요",
        },
        restart: true,
        version: state.version,
      }, 409);
    }
    return publicErrorResponse("invalid_request", 400);
  }
}
