# 아키텍처 & 계약 (정본)

이 문서는 모든 build step에 주입되는 **유일한 교차-step 계약 채널**이다. 각 step은 격리 세션이므로 여기 적힌 shape/경로/enum을 그대로 따른다.

## 디렉토리 구조
```
src/
├── app/               # Next.js 페이지 + API 라우트 핸들러(Node runtime)
├── components/        # UI 컴포넌트
├── domain/            # 순수 타입/FSM/스키마 (의존 없음)
├── lib/               # atomic-write, id 검증, 파일 IO 유틸
└── services/          # whisper 클라이언트(프록시) 등 외부 래퍼
whisper/               # 로컬 Python whisper 서비스(uv 3.11/3.12 핀 venv)
scripts/               # check-links.mjs (링크 무결성 체커)
.claude/commands/      # meeting-summarize.md
data/meetings/{id}/    # 런타임 산출물(gitignore, fixtures 제외)
fixtures/              # 테스트 픽스처(커밋): raw.md, summary happy/fallback
```

## 프로세스 & 데이터 흐름
```
브라우저(녹음, 오디오만·메모리 버퍼) ─stop─▶ POST /api/meetings/{id}/finalize(바이너리 스트림)
  app-api: audio.webm 저장(atomic) + ffmpeg -c copy → play.webm + 자동 전사 위임
app-api ─POST /transcribe(202+jobId)─▶ whisper(127.0.0.1, 배치 ko large-v3)
  whisper: raw.md(세그먼트-per-line) + segments.json 디스크 기록 → 상태 HTTP 반환
  app-api: 잡 폴링 → status.json 갱신(transcribing→transcribed)
요약 워커(로컬 CLI/Ollama) {id|latest}: raw.md → summarize-core → transcript.md + summary.json
```

```mermaid
flowchart LR
    UI["src · Recorder UI"] -->|"audio.webm (finalize)"| API["src · app-api"]
    API -->|"POST /transcribe"| W["whisper · 127.0.0.1"]
    W -->|"raw.md · segments.json"| API
    API -->|status.json| UI
    W -->|raw.md| SUM["요약 워커 · 로컬 CLI/Ollama"]
    SUM -->|"transcript.md · summary.json"| V["열람 · 내보내기"]
```

## 파일 소유권 (단일 writer, 동시성 없음 — 1인/1탭)
| 파일 | writer | 비고 |
|------|--------|------|
| `status.json` | **app-api만** | 생명주기 + `review` + `titleOverride`. `summarized`는 `summary.json` 존재로 파생. 삭제(`DELETE`)는 폴더 전체 폐기(ADR 0007) |
| `audio.webm` / `play.webm` | app-api | 원본 불변 / 리먹스 |
| `raw.md` + `segments.json` | whisper | 원본 불변 |
| `transcript.md` + `summary.json` | 요약 워커 | 재생성 가능 |

모든 쓰기는 **atomic(temp→fsync→rename)**. 공유 파일 동시 쓰기가 없으므로 락/낙관적 동시성 불필요.

## status.json 계약 (app-api 소유)
```jsonc
{
  "id": "uuid",                 // 경로 traversal 방지: 생성 UUID/안전 slug만
  "title": "회의 2026-07-05 22:30",   // 자동; summarize 시 app-api가 summary.title로 승격(단 titleOverride가 있으면 미승격)
  "titleOverride": "사용자 지정 제목", // 선택. 사용자가 목록에서 수정한 표시 제목. deriveStatus가 summary.title보다 우선 사용(ADR 0008). 없으면 자동 승격
  "status": "recording|recorded|transcribing|transcribed|summarizing|summarized",
  "error": { "message": "...", "action": "retry_transcription|retry_summary|..." } | null,
  "startedAt": "ISO", "endedAt": "ISO|null", "durationMs": 0, "audioMime": "audio/webm;codecs=opus",
  "whisper": { "jobId": "...|null", "progress": 0.0 },
  "paths": { "audio":"...","play":"...","raw":"...","transcript":"...","summary":"...","segments":"..." },
  "review": { "participants": [] },  // 상세 UI(app-api 경유) 입력
  "summarizeAttempts": 0,            // 선택. 요약 실패 횟수(워커 백오프용). 성공/수동 재시도 시 0으로 리셋
  "updatedAt": "ISO"
}
```
**FSM 6상태:** `recording → recorded → transcribing → transcribed → summarizing → summarized`. 임의 상태에서 오류 시 `error{message,action}` 세팅(상태는 유지); 복구=사용자가 "재시도" → 직전 정상 상태로 재진입. `recording`은 클라이언트 임시 상태, 서버 영속은 `recorded`부터.

## summary.json 스키마
정본(happy): `{title, topicSlug, oneLine, purpose, participants[], highlights[], discussion[], decisions[], actionItems[{owner,task,due}], risks[], followups[]}`. zod로 검증. **happy + fallback 두 픽스처 커밋.**

**중요 — fallback도 이 스키마를 준수해야 한다.** 재사용 `fallback_summary`의 `structured`는 `actionItems`를 객체로 주지만 **`purpose`가 없고 `highlights`가 빠져 있다.** summarize-core는:
- `purpose` 필드를 항상 포함(fallback 시 `""`).
- `highlights`를 항상 포함(fallback 시 `structured`에 `discussion[:3]` 등으로 채움).
- `participants`는 **비운다(`[]`)** — 참석자는 `status.review`(사용자 입력)만 authoritative. 모델이 전사에서 주운 이름을 자동 기록 금지(거짓 attendees edge·프라이버시).

## 재요약 (단건 수동)
`runSummarize(id, { force })` — `force`일 때만 `summary.json` 존재(=`already_summarized`) 조기반환을 우회해 `transcript.md`·`summary.json`(재생성 가능·요약 워커 소유)을 덮어쓴다. 유일한 트리거는 **상세의 "다시 요약" 버튼**(`POST /api/meetings/[id]/summarize` body `{ resummarize: true }`); body 없는 POST는 기존대로 요약본이 있으면 409. 배경 워커는 후보 조건이 "summary.json 없음"이고 `force`를 전달하지 않으므로 요약된 회의를 재요약하지 않는다 — **자동·일괄 재요약은 구조적으로 불가능**. 인플라이트 락은 그대로 적용되고, 사용자 `titleOverride`는 보존된다(ADR 0008).

**비동기(202) + 클라이언트 폴링(ADR 0009):** 교정+요약은 긴 회의에서 수 분 걸리므로 라우트는 동기 사전검증(id 400·미존재 404·인플라이트 409·모델 미설정 400·비-force 재요약 409) 후 `runSummarize`를 **논-await로 발사**하고 **202**를 즉시 반환한다. 완료는 클라이언트가 감지한다: `deriveStatus`가 옛 `summary.json` 존재로 재요약 중 `summarizing`을 `summarized`로 가리므로 `status.status`로는 못 본다. 대신 상세 페이지가 `isSummarizeInflight(id)`를 `resummarizeInflight` prop으로 노출하고, 상세 UI는 202 후 로컬 "요약 중" 상태로 3초마다 `router.refresh()`하며 **요약 내용 변경 → 성공(즉시)** / **인플라이트 락을 관측한 뒤 해제 시: `retry_summary` 에러면 실패·아니면 성공(동일 내용 재생성 포함)** / **~30분(생성 3콜 상한) 초과 → 타임아웃**으로 종료한다. 락 관측 전의 stale prop(옛 에러·미기동 상태)은 완료로 오인하지 않도록 게이트한다. 진행 표시(badge "요약 생성 중"·스피너·버튼 비활성)는 `resummarizing || resummarizeInflight`로 파생하므로, 재요약 중 페이지를 새로 열어 서버 락만 true여도 진행 중으로 정확히 보인다(cold entry).

**실패 가시성(ADR 0009):** 재요약이 실패하면(기존 `summary.json` 있음) 상태를 `transcribed`로 강등하지 않고 **`summarized`를 유지**한 채 `retry_summary` 에러만 첨부한다(옛 요약 보존). `deriveStatus`는 `summarized` 승격 시 `retry_summary` 에러를 **보존**한다(그 외 에러는 정리) — GET 라우트가 파생 상태를 persist하며 배너를 지우던 조용한-실패를 막기 위함. 요약본이 없는 최초 요약 실패는 기존대로 `transcribed`+에러.

**LLM 생성 타임아웃(ADR 0009):** 교정·요약 서브프로세스/요청은 `LLM_GENERATION_TIMEOUT_MS = 600_000`(10분) 고정. `exec.ts` 기본값(120초)·헬스체크의 짧은 타임아웃은 유지하고 생성 호출에만 적용한다(88분 회의가 120초에 SIGKILL되던 원인). 비동기라 사용자가 직접 대기하지 않으므로 넉넉한 상한의 부담이 작다. 한 번의 재요약은 교정→요약→(폴백 요약) **순차 최대 3콜**이라 서버 최악 예산은 ~30분이며, 클라이언트 타임아웃 폴백(`RESUMMARIZE_TIMEOUT_MS = 3×600s+30s`)은 이 예산을 넘겨 잡아 긴 회의에서 조기 오탐 타임아웃을 막는다.

## whisper HTTP 계약 (127.0.0.1)
- **주소 고정(계약)**: `LOCAL_STT_HOST=127.0.0.1`, `LOCAL_STT_PORT=8123`. whisper는 여기에 바인딩하고, app-api 프록시/클라이언트는 이 env를 (핸들러 내 지연) 읽어 접속한다. step1이 env 기본값으로 제공, step2가 바인딩, step3가 프록시.
- `GET /health` → `{ ok, model, ready }` (app-api가 same-origin 프록시 `/api/whisper/health`로 노출).
- `POST /transcribe` `{ audioPath, rawPath, segmentsPath }` → `202 { jobId }`. 잡 폴링 `GET /jobs/{jobId}` → `{ status:"processing|done|error", progress, error? }`.
- whisper가 `raw.md`(세그먼트-per-line, 분할점 보장) + `segments.json`(`[{start,end,text}]`)을 **주어진 경로에 디스크 기록**.
- `FAKE_WHISPER=1` 스텁이 **동일 계약** 준수(모델 없이 canned segments 반환) → hermetic 테스트용.
- ffmpeg는 mlx-whisper가 CLI 호출 → whisper·app-api(리먹스) 양쪽 **preflight** 체크(`/opt/homebrew/bin/ffmpeg`).

## LLM settings & health 계약
- `GET /api/settings/llm` → 저장된 `{ provider, model?, baseUrl? }` 또는 `{ provider:null }`. app-api가 `data/settings.json`의 단일 writer이며 API 키를 저장하지 않는다.
- `POST /api/settings/llm` → `{ provider:"claude-cli"|"codex-cli"|"ollama", model?, baseUrl? }`. 저장 전 `model/baseUrl`은 trim한다. `provider:"ollama"`는 `model` 필수이며 비어 있으면 400. `baseUrl`은 Ollama 설정에만 저장한다.
- `GET /api/settings/llm/health` → `{ configured:false }` 또는 `{ configured:true, provider, model?, ok, detail }`. `model`은 settings의 모델명만 노출하고 `baseUrl`은 반환하지 않는다. legacy Ollama 설정에 `model`이 없으면 daemon 상태와 무관하게 `{ ok:false, detail:"Ollama model not set" }`.
- health는 UI와 설정 화면의 readiness/test-connection 용도다. 홈 배너와 상세 상태 카드는 `configured && ok`일 때만 “요약 자동 처리 중”으로 안내한다. 배경 워커 후보 선정은 기존처럼 settings 존재 기반이며, 실제 실행 실패는 `runSummarize()`의 retryable error로 기록한다.
- Codex CLI health는 `codex --version` 수준의 binary 감지다. UI 문구는 “감지됨”으로 표시하고 인증/실제 요약 가능 여부는 첫 요약 실행에서 확인한다.

## 프롬프트 (교정·요약)

**용어집(glossary)** — `glossary.json`은 `{ terms: string[], corrections: {from,to}[] }` 객체다(구 형식인 문자열 배열은 읽기 시 `terms`로 자동 호환). `terms`=우선 적용 도메인 용어, `corrections`='잘못 인식→올바른 표기' 매핑. 앱 **"단어 관리"** 탭(app-api 단일 writer)에서 편집하며 **LLM 교정 단계**가 소비한다(whisper STT 아님). 형식 예시는 `glossary.example.json` 참조.

**교정(refine) 프롬프트** — 정본은 코드 `src/lib/summarizePrompts.ts`(`buildCorrectionPrompt`); 아래는 그 미러다(드리프트 가드 테스트가 규칙 문구를 verbatim 검증). `{terms}`=쉼표 결합 용어, `{corrections}`=`잘못→올바름` 쌍(비면 5) 규칙 생략, 이후 번호 당김):
```
다음은 한국어 회의를 음성인식(STT)으로 전사한 원문입니다.
당신의 역할은 STT 오인식 교정기입니다. 규칙을 반드시 지키세요.
1) 잘못 인식된 단어·띄어쓰기·맞춤법·문장부호·문단 구분을 자연스럽게 교정합니다.
2) 발화 내용을 추가/삭제/요약/의역하지 않습니다. 말한 것을 최대한 보존합니다.
   (예외) 숫자·날짜·시간·금액은 아라비아 숫자로 정규화합니다(예: '삼백만원'→'300만원', '이천이십사년'→'2024년', '세시 반'→'3시 30분'). 값 자체는 바꾸지 말고 표기만 정규화하며, 이는 규칙 2)의 유일한 예외입니다.
3) 군더더기(음..., 어..., 의미 없는 반복)는 가독성을 위해 최소한으로만 정리할 수 있습니다.
4) 다음 도메인 용어를 우선 적용해 교정하세요: {terms}
5) 다음은 자주 잘못 인식되는 표기입니다. 왼쪽(잘못 인식)을 오른쪽(올바른 표기)으로 교정하세요: {corrections}
6) 교정된 전사 텍스트만 출력합니다. 사고 과정·설명·머리말·분석·메모·영어·따옴표·코드블록 절대 금지. 첫 글자부터 바로 교정된 전사여야 합니다.
7) 원문이 무의미하거나 비어 있어도 분석하지 말고, 원문을 그대로(또는 최소 정리해) 출력만 하세요.

[원문]
```
- **길이 sanity guard**: 교정본 길이가 원문의 30% 미만이면 그 부분은 원문 유지(over-edit 방지). MVP는 단일패스(전체를 한 번에). refine 실패/폴백 시에도 최소 세그먼트→문장 병합으로 가독 floor 확보.

**요약(summarize) 프롬프트**:
```
당신은 한국어 회의록 요약 도우미입니다. 아래 전사를 바탕으로 회의록을 구조화하세요.
규칙:
- 전사에 근거한 내용만 작성합니다. 추측/창작 금지.
- 담당자가 불명확하면 owner는 "TODO"로 둡니다.
- 기한이 없으면 due는 "미정".
- topicSlug만 영문 kebab-case, 나머지 텍스트는 모두 한국어.
- 출력은 순수 JSON 객체 하나만. 코드블록/설명/머리말 금지.
JSON 스키마: {SUMMARY_SCHEMA_HINT}

[회의 제목] {title}
[전사]
{transcript}
```
**SUMMARY_SCHEMA_HINT** (여기에 `purpose`를 추가해 사용):
```
{"title":"회의 제목(한국어)","topicSlug":"english-kebab-core-topic","oneLine":"한 줄 요약",
 "purpose":"이 회의의 목적/안건","participants":["이름"],"highlights":["핵심 논의 불릿"],
 "discussion":["논의 상세 불릿"],"decisions":["결정사항"],
 "actionItems":[{"owner":"담당자","task":"할 일","due":"기한"}],
 "risks":["리스크/이슈"],"followups":["후속 확인/티켓 제안"]}
```
- **파싱**: `{…}` 추출 → 1회 재시도 → 스키마 검증 → 실패 시 스키마 준수 fallback.

## 상태 관리
- 서버 상태(회의 목록/상태): app-api가 `data/meetings/*/status.json`을 읽어 파생. 클라이언트는 폴링(`force-dynamic`+`no-store`).
- 클라이언트 상태: React `useState/useReducer`(녹음 세션, 탭 등). 전역 상태 라이브러리 불필요.
