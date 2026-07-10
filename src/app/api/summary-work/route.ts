import { guardLocalApiRequest } from "@/lib/localRequestGuard";
import { jsonNoStore, publicErrorResponse } from "@/lib/publicApi";
import { getSummaryWork } from "@/lib/summaryWorkCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const unknown = [...url.searchParams.keys()].some((key) => key !== "attentionAfter");
  if (unknown) return publicErrorResponse("invalid_request", 400);
  try {
    return jsonNoStore(await getSummaryWork(url.searchParams.get("attentionAfter")));
  } catch {
    return publicErrorResponse("invalid_request", 400, { field: "attentionAfter" });
  }
}
