import { NextResponse } from "next/server";

import { readSettings } from "@/lib/settings";
import { getAdapter } from "@/services/llm";

// GET /api/settings/llm/health — the settings "test connection" check. Returns the
// configured backend's reachability/auth status; a thrown check degrades to ok:false.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const s = await readSettings();
  if (!s) return NextResponse.json({ configured: false });
  const model = s.model?.trim();

  if (s.provider === "ollama" && !model) {
    return NextResponse.json({
      configured: true,
      provider: s.provider,
      ok: false,
      detail: "Ollama model not set",
    });
  }

  try {
    const adapter = getAdapter(s);
    const health = await adapter.health();
    return NextResponse.json({
      configured: true,
      provider: s.provider,
      ...(model ? { model } : {}),
      ...health,
    });
  } catch (err) {
    return NextResponse.json({
      configured: true,
      provider: s.provider,
      ...(model ? { model } : {}),
      ok: false,
      detail: String((err instanceof Error ? err.message : err) ?? err),
    });
  }
}
