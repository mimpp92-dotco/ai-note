import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { guardLocalApiRequest } from "@/lib/localRequestGuard";
import { dataRoot } from "@/lib/paths";
import { jsonNoStore, publicErrorResponse, safeLog } from "@/lib/publicApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  const root = dataRoot();
  if (!existsSync(root)) return publicErrorResponse("meeting_not_found", 404);
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "explorer"
      : "xdg-open";
  try {
    const child = spawn(command, [root], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    safeLog("warn", { code: "reveal_failed", operation: "library_reveal" });
    return publicErrorResponse("internal_error", 500);
  }
  return jsonNoStore({ ok: true });
}
