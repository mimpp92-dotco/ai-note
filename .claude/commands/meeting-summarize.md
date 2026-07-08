회의 원문 전사(`raw.md`)를 교정하고 구조화 요약을 생성한다. 인자: `{id|latest}` (없거나 `latest`면 **가장 최근에 전사만 끝난** 회의).

## 이 커맨드의 역할 (읽고 반드시 지킬 것)
- LLM 작업(교정·요약)은 **이 커맨드(Claude)가 직접** 수행한다. 앱 코드는 LLM을 호출하지 않는다($0 원칙).
- 파싱·검증·기록은 결정적 코어 `src/lib/summarizeCore.ts`가 담당한다. 이 커맨드는 코어에 **원시 출력 문자열만 넘긴다**.
- **`status.json`을 쓰지 마라.** 상태는 app-api가 `summary.json` 존재로 `summarized`를 파생하고 `summary.title`을 승격한다(단일 writer=app-api).
- `raw.md`·`segments.json`은 **불변**. 읽기만 한다. 재생성 대상은 `transcript.md`·`summary.json`뿐.
- **`participants`는 절대 채우지 않는다(빈 배열).** 참석자는 사용자가 상세 화면에서 입력하는 `status.review`만 authoritative. 모델이 전사에서 주운 이름을 기록 금지(거짓 attendees·프라이버시). 코어가 강제로 `[]`로 만든다.
- 단일패스로만 처리한다(map-reduce/청킹 금지 — MVP-0). 전사가 매우 길면 코어가 요약에 "일부 잘림" 문구를 붙인다.

## 읽어야 할 파일 (저장소 루트 기준 상대경로)
- `docs/ARCHITECTURE.md` — 교정/요약 프롬프트 정본, `summary.json` 스키마, fallback 준수 규칙.
- `glossary.json` — 도메인 용어집(교정 프롬프트에 주입).
- `src/lib/summarizeCore.ts` — 코어 입출력 계약.

## 절차

### 1. 회의 id 결정
- 인자가 UUID/안전 slug면 그 id.
- 인자가 없거나 `latest`면 `data/meetings/*/`를 스캔해 **`raw.md`는 있고 `summary.json`은 없는**(= `transcribed`) 회의 중 가장 최근 것(각 `status.json`의 `startedAt` 기준)을 고른다. 없으면 "교정 대기 중인 회의가 없습니다"를 알리고 종료.

### 2. 입력 로드
- `data/meetings/{id}/raw.md`(세그먼트-per-line 원문)와 `data/meetings/{id}/status.json`(제목용 `title`)을 읽는다.
- `glossary.json`을 읽어 쉼표로 결합한 문자열 `{glossary}`를 만든다.

### 3. 교정 (ARCHITECTURE의 교정 프롬프트 verbatim + glossary)
아래 헤더 뒤에 `raw.md` 전체를 붙여 **너(Claude)가 직접** 교정한다. `{glossary}`는 2단계의 결합 문자열로 치환:
```
다음은 한국어 회의를 음성인식(STT)으로 전사한 원문입니다.
당신의 역할은 STT 오인식 교정기입니다. 규칙을 반드시 지키세요.
1) 잘못 인식된 단어·띄어쓰기·맞춤법·문장부호·문단 구분을 자연스럽게 교정합니다.
2) 발화 내용을 추가/삭제/요약/의역하지 않습니다. 말한 것을 최대한 보존합니다.
3) 군더더기(음..., 어..., 의미 없는 반복)는 가독성을 위해 최소한으로만 정리할 수 있습니다.
4) 다음 도메인 용어를 우선 적용해 교정하세요: {glossary}
5) 교정된 전사 텍스트만 출력합니다. 설명/머리말/코드블록 금지.

[원문]
```
- 교정 결과 텍스트를 `data/meetings/{id}/.correction.txt`에 그대로 저장한다(코드블록/머리말 없이).
- 길이 sanity guard는 코어가 처리한다(교정본이 원문의 30% 미만이면 원문 유지). 너는 신경 쓰지 말고 최선의 교정본만 낸다.

### 4. 요약 (ARCHITECTURE의 요약 프롬프트 verbatim + purpose 포함 스키마 힌트)
교정본을 `{transcript}`, status의 `title`을 `{title}`로 넣어 **너가 직접** 순수 JSON 하나를 생성한다. `{SUMMARY_SCHEMA_HINT}`는 아래 **purpose 포함** 버전을 사용:
```
당신은 한국어 회의록 요약 도우미입니다. 아래 전사를 바탕으로 회의록을 구조화하세요.
규칙:
- 전사에 근거한 내용만 작성합니다. 추측/창작 금지.
- 담당자가 불명확하면 owner는 "TODO"로 둡니다.
- 기한이 없으면 due는 "미정".
- topicSlug만 영문 kebab-case, 나머지 텍스트는 모두 한국어.
- 출력은 순수 JSON 객체 하나만. 코드블록/설명/머리말 금지.
JSON 스키마: {"title":"회의 제목(한국어)","topicSlug":"english-kebab-core-topic","oneLine":"한 줄 요약","purpose":"이 회의의 목적/안건","participants":["이름"],"highlights":["핵심 논의 불릿"],"discussion":["논의 상세 불릿"],"decisions":["결정사항"],"actionItems":[{"owner":"담당자","task":"할 일","due":"기한"}],"risks":["리스크/이슈"],"followups":["후속 확인/티켓 제안"]}

[회의 제목] {title}
[전사]
{transcript}
```
- `participants`는 스키마 힌트에 있어도 채우지 마라(빈 배열). 코어가 어차피 버린다.
- 생성한 요약 JSON 원시 문자열을 `data/meetings/{id}/.summary-raw.txt`에 저장한다.

### 5. 코어로 파싱·검증·기록
아래 러너를 `data/meetings/{id}/.run-summarize.mts`로 쓰고 실행한다(코어가 `transcript.md`·`summary.json`을 **atomic**하게 기록). `data/`는 gitignore이므로 임시 파일은 커밋되지 않는다.
```ts
import { readFile } from "node:fs/promises";

import { meetingPaths } from "@/lib/paths";
import { readStatus } from "@/lib/status";
import { summarizeCore } from "@/lib/summarizeCore";

const id = process.argv[2];
const p = meetingPaths(id);
const status = await readStatus(id);
const [raw, correction, summaryOutput] = await Promise.all([
  readFile(p.raw, "utf-8"),
  readFile(`${p.dir}/.correction.txt`, "utf-8"),
  readFile(`${p.dir}/.summary-raw.txt`, "utf-8"),
]);
const result = await summarizeCore({
  title: status?.title ?? "회의",
  raw,
  correction,
  summaryOutput,
  transcriptPath: p.transcript,
  summaryPath: p.summary,
});
console.log(JSON.stringify({ usedFallback: result.usedFallback, truncated: result.truncated }));
```
실행(런타임에 tsx가 tsconfig의 `@/` 별칭을 해석):
```bash
# 저장소 루트에서 실행
npx -y tsx .run-summarize.mts "{id}" || npx -y tsx data/meetings/{id}/.run-summarize.mts "{id}"
```
- 실제 러너 경로는 `data/meetings/{id}/.run-summarize.mts`이다. 실행 후 `.run-summarize.mts`·`.correction.txt`·`.summary-raw.txt` 임시 파일을 삭제한다.
- 러너가 `usedFallback:true`를 반환하면 요약 파싱이 실패해 스키마 준수 fallback이 기록된 것 — 요약 JSON을 다시 한 번 더 정성껏 생성해(1회 재시도) 5번을 반복하라. 두 번째도 실패하면 fallback을 그대로 둔다.

### 6. 결과 보고
- 기록된 파일 경로(`transcript.md`, `summary.json`)와 `usedFallback`/`truncated` 여부를 사용자에게 알린다.
- `status.json`은 손대지 않았고, app-api가 `summary.json` 존재로 `summarized`를 파생한다고 명시한다.
