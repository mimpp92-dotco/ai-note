import type { LlmAdapter, LlmHealth, LlmProvider, LlmSettings } from "@/services/llm/types";

// Deterministic offline backend for FAKE_LLM=1 (tests / AC smokes). No process,
// no network. Two behaviors keyed off the prompt:
//   - summary step (opts.json or the "JSON 스키마" marker) → a canned schema-valid
//     summary JSON string.
//   - correction step → passthrough of the raw transcript after the "[원문]"
//     marker (identical length ⇒ clears summarizeCore's 30% over-edit guard).

const CANNED_SUMMARY = JSON.stringify({
  title: "FAKE 회의 요약",
  topicSlug: "fake-meeting",
  oneLine: "FAKE_LLM 모드에서 생성된 테스트용 요약입니다.",
  purpose: "파이프라인을 검증하기 위한 가짜 요약입니다.",
  participants: [],
  highlights: ["첫 번째 핵심 논의 항목", "두 번째 핵심 논의 항목"],
  discussion: ["논의 상세 항목 1", "논의 상세 항목 2"],
  decisions: [],
  actionItems: [{ owner: "TODO", task: "후속 작업 정리", due: "미정" }],
  risks: [],
  followups: [],
});

const RAW_MARKER = "[원문]";

export class FakeAdapter implements LlmAdapter {
  readonly provider: LlmProvider;

  constructor(settings?: LlmSettings) {
    this.provider = settings?.provider ?? "claude-cli";
  }

  async run(prompt: string, opts?: { json?: boolean }): Promise<string> {
    if (opts?.json || prompt.includes("JSON 스키마")) return CANNED_SUMMARY;
    const idx = prompt.indexOf(RAW_MARKER);
    if (idx !== -1) return prompt.slice(idx + RAW_MARKER.length).trim();
    return prompt;
  }

  async health(): Promise<LlmHealth> {
    return { ok: true, detail: "FAKE_LLM" };
  }
}
