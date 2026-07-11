import { z } from "zod";

import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import { jsonNoStore, publicErrorResponse } from "@/lib/publicApi";
import { readSettings, writeSettings } from "@/lib/settings";

// GET/POST /api/settings/llm — the LLM backend choice. app-api is the single writer
// of data/settings.json; it holds no secrets (provider + optional model/baseUrl only).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const settingsSchema = z.object({
  provider: z.enum(["claude-cli", "codex-cli", "ollama"]),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
}).strict();

export async function GET(request: Request) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  const settings = await readSettings();
  return jsonNoStore(settings ?? { provider: null });
}

export async function POST(request: Request) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await parseBoundedJsonBody(request, 32 * 1024);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return publicErrorResponse("invalid_request", 400);
  }

  const model = parsed.data.model?.trim();
  if (parsed.data.provider === "ollama" && !model) {
    return publicErrorResponse("invalid_request", 400, { field: "model" });
  }

  const settings = {
    provider: parsed.data.provider,
    ...(model ? { model } : {}),
    ...(parsed.data.provider === "ollama" && parsed.data.baseUrl?.trim()
      ? { baseUrl: parsed.data.baseUrl.trim() }
      : {}),
  };
  try {
    await writeSettings(settings);
  } catch {
    return publicErrorResponse("invalid_request", 400, { field: "baseUrl" });
  }
  return jsonNoStore(await readSettings());
}
