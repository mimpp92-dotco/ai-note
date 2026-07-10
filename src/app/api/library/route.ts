import { guardLocalApiRequest } from "@/lib/localRequestGuard";
import { authoritativeLibraryResponse } from "@/lib/libraryHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  return authoritativeLibraryResponse();
}
