import { NextResponse } from "next/server";
import { z } from "zod";

import { readSettings, writeSettings } from "@/lib/settings";

// GET/POST /api/settings/llm — the LLM backend choice. app-api is the single writer
// of data/settings.json; it holds no secrets (provider + optional model/baseUrl only).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const settingsSchema = z.object({
  provider: z.enum(["claude-cli", "codex-cli", "ollama"]),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
});

export async function GET() {
  const settings = await readSettings();
  return NextResponse.json(settings ?? { provider: null });
}

export async function POST(request: Request) {
  const parsed = settingsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid settings body" }, { status: 400 });
  }

  await writeSettings(parsed.data);
  return NextResponse.json(parsed.data);
}
