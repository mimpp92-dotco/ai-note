import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { guardLocalApiRequest } from "@/lib/localRequestGuard";
import { meetingFenceResponse } from "@/lib/meetingFence";
import { assertSafeId } from "@/lib/meetingId";
import { meetingPaths } from "@/lib/paths";
import { jsonNoStore, publicErrorResponse, safeLog } from "@/lib/publicApi";

// POST /api/meetings/[id]/reveal — open the meeting's data/ folder in the OS file
// manager. Local-only convenience (server binds 127.0.0.1). Fire-and-forget: the
// viewer is detached + unref'd so it outlives the request, and a nonzero exit
// (explorer does this) is not an error since we never wait on it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const dir = meetingPaths(id).dir;
  if (!existsSync(dir)) {
    return publicErrorResponse("meeting_not_found", 404, { meetingId: id });
  }

  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open";

  try {
    const child = spawn(cmd, [dir], { detached: true, stdio: "ignore" });
    // The failure of a missing viewer (e.g. no xdg-open on a headless Linux box)
    // arrives async via 'error' AFTER this try returns; without a listener that
    // would be an uncaughtException and crash the server. Swallow it.
    child.on("error", () => {});
    child.unref();
  } catch {
    safeLog("warn", { code: "reveal_failed", operation: "reveal", meetingId: id });
    return publicErrorResponse("internal_error", 500);
  }

  return jsonNoStore({ ok: true });
}
