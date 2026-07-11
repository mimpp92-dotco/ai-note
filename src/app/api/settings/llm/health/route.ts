import { guardLocalApiRequest } from "@/lib/localRequestGuard";
import { jsonNoStore } from "@/lib/publicApi";
import { readSettings } from "@/lib/settings";
import { getAdapter } from "@/services/llm";

// GET /api/settings/llm/health — the settings "test connection" check. Returns the
// configured backend's reachability/auth status; a thrown check degrades to ok:false.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  const s = await readSettings();
  if (!s) return jsonNoStore({ configured: false });
  const model = s.model?.trim();

  if (s.provider === "ollama" && !model) {
    return jsonNoStore({
      configured: true,
      provider: s.provider,
      ok: false,
      detail: "Ollama model not set",
    });
  }

  try {
    const adapter = getAdapter(s);
    const health = await adapter.health();
    return jsonNoStore({
      configured: true,
      provider: s.provider,
      ...(model ? { model } : {}),
      ...health,
    });
  } catch {
    return jsonNoStore({
      configured: true,
      provider: s.provider,
      ...(model ? { model } : {}),
      ok: false,
      detail: "설정한 로컬 요약 서비스를 확인할 수 없습니다",
    });
  }
}
