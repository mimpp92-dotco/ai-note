import { guardLocalApiRequest } from "@/lib/localRequestGuard";
import { jsonNoStore } from "@/lib/publicApi";
import { readSettings } from "@/lib/settings";
import { getAdapter } from "@/services/llm";

// GET /api/settings/llm/health — checks only the persisted configuration. CLI
// providers detect the binary; Ollama verifies loopback reachability + exact model.
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
      detail: "Ollama 모델을 선택해 저장하세요.",
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
      detail: s.provider === "ollama"
        ? "Ollama 설정을 확인하고 ollama serve를 실행한 뒤 다시 검사하세요."
        : `${s.provider === "claude-cli" ? "Claude" : "Codex"} CLI 설치와 PATH를 확인한 뒤 다시 검사하세요.`,
    });
  }
}
