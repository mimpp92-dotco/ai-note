import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { NextResponse } from "next/server";

import { assertSafeId } from "@/lib/meetingId";
import { meetingPaths } from "@/lib/paths";

// POST /api/meetings/[id]/reveal — open the meeting's data/ folder in the OS file
// manager. Local-only convenience (server binds 127.0.0.1). Fire-and-forget: the
// viewer is detached + unref'd so it outlives the request, and a nonzero exit
// (explorer does this) is not an error since we never wait on it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let id: string;
  try {
    id = assertSafeId((await params).id);
  } catch {
    return NextResponse.json({ error: "invalid meeting id" }, { status: 400 });
  }

  const dir = meetingPaths(id).dir;
  if (!existsSync(dir)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
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
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
