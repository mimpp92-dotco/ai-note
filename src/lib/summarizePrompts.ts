// Prompt templates for the in-app summarizer (canonical copy — the manual
// `/meeting-summarize` command mirrors these). The correction step fixes STT
// errors without changing meaning; the summary step emits one JSON object that
// summarizeCore validates against summarySchema.

export const SUMMARY_SCHEMA_HINT =
  '{"title":"회의 제목(한국어)","topicSlug":"english-kebab-core-topic","oneLine":"한 줄 요약","purpose":"이 회의의 목적/안건","participants":["이름"],"highlights":["핵심 논의 불릿"],"discussion":["논의 상세 불릿"],"decisions":["결정사항"],"actionItems":[{"owner":"담당자","task":"할 일","due":"기한"}],"risks":["리스크/이슈"],"followups":["후속 확인/티켓 제안"]}';

export function buildCorrectionPrompt(raw: string, glossary: string): string {
  return `다음은 한국어 회의를 음성인식(STT)으로 전사한 원문입니다.
당신의 역할은 STT 오인식 교정기입니다. 규칙을 반드시 지키세요.
1) 잘못 인식된 단어·띄어쓰기·맞춤법·문장부호·문단 구분을 자연스럽게 교정합니다.
2) 발화 내용을 추가/삭제/요약/의역하지 않습니다. 말한 것을 최대한 보존합니다.
3) 군더더기(음..., 어..., 의미 없는 반복)는 가독성을 위해 최소한으로만 정리할 수 있습니다.
4) 다음 도메인 용어를 우선 적용해 교정하세요: ${glossary}
5) 교정된 전사 텍스트만 출력합니다. 사고 과정·설명·머리말·분석·메모·영어·따옴표·코드블록 절대 금지. 첫 글자부터 바로 교정된 전사여야 합니다.
6) 원문이 무의미하거나 비어 있어도 분석하지 말고, 원문을 그대로(또는 최소 정리해) 출력만 하세요.

[원문]
${raw}`;
}

export function buildSummaryPrompt(transcript: string, title: string): string {
  return `당신은 한국어 회의록 요약 도우미입니다. 아래 전사를 바탕으로 회의록을 구조화하세요.
규칙:
- 전사에 근거한 내용만 작성합니다. 추측/창작 금지.
- 담당자가 불명확하면 owner는 "TODO"로 둡니다.
- 기한이 없으면 due는 "미정".
- topicSlug만 영문 kebab-case, 나머지 텍스트는 모두 한국어.
- 출력은 순수 JSON 객체 하나만. 코드블록/설명/머리말 금지.
JSON 스키마: ${SUMMARY_SCHEMA_HINT}

[회의 제목] ${title}
[전사]
${transcript}`;
}

// Load glossary terms as a comma-joined string for the correction prompt.
// Empty/missing glossary → empty string (the rule then applies to nothing).
export function formatGlossary(terms: unknown): string {
  if (!Array.isArray(terms)) return "";
  return terms.filter((t): t is string => typeof t === "string").join(", ");
}
