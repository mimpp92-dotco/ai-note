import { NextResponse } from "next/server";

import { fetchWhisperHealth } from "@/services/whisperClient";

// Same-origin proxy to the local whisper service /health (127.0.0.1:8123, read
// lazily via config). A whisper outage is not an error here — it maps to
// connected:false so the header pill can show "연결 안 됨" without a failed fetch.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const health = await fetchWhisperHealth();
    return NextResponse.json({ connected: true, ...health });
  } catch {
    return NextResponse.json(
      { connected: false, ok: false, ready: false, model: null },
      { status: 200 },
    );
  }
}
