import { actionItemSchema, summarySchema } from "@/domain/summarySchema";
import type { ActionItem, Summary } from "@/domain/summary";

// Deterministic summarize core (docs/ARCHITECTURE.md). The LLM work is done by the
// `/meeting-summarize` command; this module only parses/validates its raw output
// and returns staging payloads. It deliberately has no path or filesystem write
// capability; the private summarize publisher owns canonical publication.
// NO LLM calls here ($0).
//
// Contract guarantees enforced regardless of what the model returned:
// - `purpose` and `highlights` are always present (fallback fills purpose:"",
//   highlights from discussion[:3]).
// - `participants` is always [] — attendees come from status.review only; a model
//   must never seed them (false-attendee edge / privacy).
// - transcript over-edit guard: a correction shorter than 30% of the raw transcript
//   is discarded in favor of the original.

// Single-pass cap (MVP-0: no map-reduce chunking). Our own value — do NOT copy the
// reference's CLAUDE_MAX_INPUT=48000.
const MAX_TRANSCRIPT_CHARS = 40_000;
const TRUNCATION_NOTICE =
  "⚠️ 전사가 길어 요약은 앞부분만 반영되었습니다 — 전체 스크립트 탭을 확인하세요.";

export interface SummarizeInput {
  title: string;
  /** Original raw.md transcript (immutable) — baseline for the over-edit guard and fallback source. */
  raw: string;
  /** LLM correction output (may carry code fences / a leading meta line). */
  correction: string;
  /** LLM summary output (a JSON object, possibly fenced or wrapped in prose). */
  summaryOutput: string;
}

export interface SummarizeResult {
  transcript: string;
  summary: Summary;
  usedFallback: boolean;
  truncated: boolean;
}

export async function summarizeCore(
  input: SummarizeInput,
): Promise<SummarizeResult> {
  const transcript = resolveTranscript(input.raw, input.correction);
  const truncated = transcript.length > MAX_TRANSCRIPT_CHARS;

  const parsed = parseSummary(input.summaryOutput, input.title);
  const usedFallback = parsed === null;
  const summary = parsed ?? fallbackSummary(input.title, transcript);

  if (truncated && !summary.followups.includes(TRUNCATION_NOTICE)) {
    summary.followups.push(TRUNCATION_NOTICE);
  }

  return { transcript, summary, usedFallback, truncated };
}

// --- transcript correction --------------------------------------------------

// Over-edit guard: keep the raw transcript if the correction collapsed to under
// 30% of the original length (a healthy STT correction stays roughly the same size).
// Exported so the summarizer feeds the SAME resolved transcript to the summary
// prompt that gets persisted as transcript.md.
export function resolveTranscript(raw: string, correction: string): string {
  const cleaned = stripWrappers(correction);
  const floor = Math.max(8, Math.floor(raw.length * 0.3));
  if (cleaned.length < floor) return raw;
  // Contamination guard: models sometimes ignore "output only the corrected text"
  // and return their reasoning/preamble (often in English) instead of a faithful
  // correction. If the correction's script diverges sharply from the raw (raw is
  // predominantly non-Latin, e.g. Korean, but the correction turned mostly Latin
  // prose), it isn't a correction — keep the raw STT rather than persist chatter.
  if (looksContaminated(raw, cleaned)) return raw;
  return cleaned;
}

function scriptCounts(s: string): { latin: number; cjk: number } {
  let latin = 0;
  let cjk = 0;
  for (const ch of s) {
    if (ch >= "A" && ch <= "Z") latin++;
    else if (ch >= "a" && ch <= "z") latin++;
    else if (/[가-힣぀-ヿ一-鿿]/.test(ch)) cjk++;
  }
  return { latin, cjk };
}

function looksContaminated(raw: string, correction: string): boolean {
  const r = scriptCounts(raw);
  const c = scriptCounts(correction);
  const rawTotal = r.latin + r.cjk;
  const corrTotal = c.latin + c.cjk;
  if (rawTotal < 10 || corrTotal < 10) return false; // too little signal to judge
  const rawLatinFrac = r.latin / rawTotal;
  const corrLatinFrac = c.latin / corrTotal;
  return rawLatinFrac < 0.2 && corrLatinFrac > 0.4;
}

function stripWrappers(text: string): string {
  let t = text.trim();
  const fence = t.match(/^```[a-zA-Z]*\n([\s\S]*)\n```$/);
  if (fence) t = fence[1].trim();
  // drop a leading meta line like "교정된 전사:" the model sometimes prepends.
  t = t.replace(/^(교정(된)?\s*전사|corrected transcript|결과)\s*[:：]\s*\n?/i, "");
  return t.trim();
}

// --- summary parsing --------------------------------------------------------

// Returns a validated Summary, or null when the output could not be parsed into
// a schema-valid object (caller uses the fallback). Parsing tries a fenced block
// first, then retries with a loose brace scan (the "1회 재시도").
function parseSummary(output: string, title: string): Summary | null {
  const obj = extractJsonObject(output);
  if (!obj) return null;
  const normalized = normalizeSummary(obj, title);
  const result = summarySchema.safeParse(normalized);
  return result.success ? result.data : null;
}

// Tolerant JSON-object salvage from free-form model output. Shared with the
// chatbot envelope parser (chatOrchestrator): local CLIs emit fenced or
// prose-wrapped JSON, so a bare JSON.parse on the whole output fails. Tries a
// fenced block first, then a first-`{` to last-`}` scan.
export function extractJsonObject(output: string): Record<string, unknown> | null {
  const t = output.trim();
  // attempt 1: a ```json { ... } ``` fenced block.
  const fence = t.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fence) {
    const obj = tryParseObject(fence[1]);
    if (obj) return obj;
  }
  // retry: first "{" to last "}" (handles prose before/after the object).
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const obj = tryParseObject(t.slice(start, end + 1));
    if (obj) return obj;
  }
  return null;
}

function tryParseObject(candidate: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Coerce a parsed object into the contract shape, enforcing the invariants that
// don't depend on the model (participants:[], purpose/highlights always present).
function normalizeSummary(
  data: Record<string, unknown>,
  title: string,
): Summary {
  const discussion = stringArray(data.discussion);
  let highlights = stringArray(data.highlights);
  if (highlights.length === 0) {
    highlights = discussion.slice(0, 3);
    if (highlights.length === 0 && str(data.oneLine)) {
      highlights = [str(data.oneLine)];
    }
  }
  return {
    title: str(data.title) || title,
    topicSlug: str(data.topicSlug),
    oneLine: str(data.oneLine),
    purpose: str(data.purpose),
    participants: [], // never seeded from the model
    highlights,
    discussion,
    decisions: stringArray(data.decisions),
    actionItems: normalizeActionItems(data.actionItems),
    risks: stringArray(data.risks),
    followups: stringArray(data.followups),
  };
}

function normalizeActionItems(value: unknown): ActionItem[] {
  if (!Array.isArray(value)) return [];
  const items: ActionItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const task = str(o.task);
    if (!task) continue;
    items.push({
      owner: str(o.owner) || "TODO",
      task,
      due: str(o.due) || "미정",
    });
  }
  // validate each item against the contract before trusting it.
  return items.filter((item) => actionItemSchema.safeParse(item).success);
}

// --- fallback ---------------------------------------------------------------

// Schema-compliant summary built by sentence extraction when parsing fails.
// purpose:"" and participants:[] per contract; highlights filled from the transcript.
function fallbackSummary(title: string, transcript: string): Summary {
  const sentences = transcript
    .split(/[.!?。\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const highlights = sentences.slice(0, 3);
  const actionLines = sentences
    .filter((s) => /액션|해야|다음|todo/i.test(s))
    .slice(0, 5);
  const risks = sentences
    .filter((s) => /리스크|위험|장애|실패|권한|보안/.test(s))
    .slice(0, 5);
  return {
    title,
    topicSlug: "meeting",
    oneLine: highlights[0] ?? "전사 요약 생성에 실패하여 최소 구조만 제공합니다.",
    purpose: "",
    participants: [],
    highlights: highlights.length
      ? highlights
      : ["전사 내용이 비어 있어 요약을 만들 수 없습니다. 오디오 품질을 확인하세요."],
    discussion: sentences.slice(0, 8),
    decisions: [],
    actionItems: actionLines.length
      ? actionLines.map((task) => ({ owner: "TODO", task, due: "미정" }))
      : [{ owner: "TODO", task: "회의 내용 검토 후 액션 아이템 정리", due: "미정" }],
    risks,
    followups: [],
  };
}

// --- small coercion helpers -------------------------------------------------

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}
