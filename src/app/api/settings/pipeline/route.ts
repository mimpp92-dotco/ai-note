import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import {
  pipelineSettingsSchema,
  readPipelineSettings,
  writePipelineSettings,
} from "@/lib/pipelineSettings";
import { jsonNoStore, publicErrorResponse } from "@/lib/publicApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024;

export async function GET(request: Request): Promise<Response> {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;

  const result = await readPipelineSettings();
  if (result.state === "unavailable") {
    return publicErrorResponse("pipeline_settings_unavailable", 503);
  }
  return jsonNoStore({
    source: result.state,
    settings: result.settings,
  });
}

export async function POST(request: Request): Promise<Response> {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await parseBoundedJsonBody(request, MAX_BODY_BYTES);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  const parsed = pipelineSettingsSchema.safeParse(body);
  if (!parsed.success) return publicErrorResponse("invalid_request", 400);

  try {
    return jsonNoStore(await writePipelineSettings(parsed.data));
  } catch {
    return publicErrorResponse("internal_error", 500);
  }
}
