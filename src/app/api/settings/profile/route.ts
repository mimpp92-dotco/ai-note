import { userProfileSchema } from "@/domain/userProfile";
import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import { jsonNoStore, publicErrorResponse } from "@/lib/publicApi";
import { readUserProfile, writeUserProfile } from "@/lib/userProfile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;

export async function GET(request: Request): Promise<Response> {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;

  try {
    return jsonNoStore(await readUserProfile());
  } catch {
    return publicErrorResponse("internal_error", 500);
  }
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

  const parsed = userProfileSchema.safeParse(body);
  if (!parsed.success) {
    return publicErrorResponse("invalid_request", 400);
  }

  try {
    const result = await writeUserProfile(parsed.data);
    return jsonNoStore({
      configured: true,
      profile: result.profile,
      durability: result.durability,
    });
  } catch {
    return publicErrorResponse("internal_error", 500);
  }
}
