import { guardLocalApiRequest } from "@/lib/localRequestGuard";
import {
  OrganizationPendingError,
  readOrganizationPendingPage,
} from "@/lib/organizationPending";
import { jsonNoStore, publicErrorResponse } from "@/lib/publicApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const allowed = new Set(["cursor", "limit"]);
  if ([...url.searchParams.keys()].some((key) => (
    !allowed.has(key) || url.searchParams.getAll(key).length !== 1
  ))) return publicErrorResponse("invalid_request", 400);
  const limitText = url.searchParams.get("limit");
  if (limitText !== null && !/^[1-9][0-9]*$/u.test(limitText)) {
    return publicErrorResponse("invalid_request", 400, { field: "limit" });
  }
  try {
    return jsonNoStore(await readOrganizationPendingPage({
      cursor: url.searchParams.get("cursor"),
      limit: limitText === null ? undefined : Number(limitText),
    }));
  } catch (error) {
    if (error instanceof OrganizationPendingError && error.code === "stale_cursor") {
      return jsonNoStore({
        error: {
          code: "stale_organization_pending_cursor",
          message: "위치 저장 대기 목록이 변경되었습니다. 처음부터 다시 불러와 주세요",
        },
        restart: true,
      }, 409);
    }
    return publicErrorResponse("invalid_request", 400);
  }
}
