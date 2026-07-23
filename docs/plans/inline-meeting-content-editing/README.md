# Inline meeting content editing

## 배경과 목표

전체 스크립트와 회의록 요약의 탭 전용 작업 버튼이 긴 본문 끝에 있어 다시 찾기 어렵고, 수정 UI가 읽기 본문 아래에 별도 편집 surface로 추가되어 같은 내용을 두 번 보여 준다. 특히 회의록 요약은 구조화 필드마다 입력해야 해 작은 문구나 섹션 제목을 자유롭게 고치는 흐름과 맞지 않는다.

이 계획은 두 탭의 작업 버튼을 탭 목록 바로 아래로 올리고, 수정할 때 읽기 본문 자체를 하나의 multiline textarea로 교체한다. 회의록 요약의 수동 수정 결과는 섹션 제목을 포함해 자유롭게 지울 수 있는 하나의 plain-text 본문을 정본으로 저장한다.

## 합의된 요구사항

### R1 — 탭 바로 아래의 로컬 작업 위계

- 선택된 탭의 작업 group은 tablist 직후, 경고·읽기 본문·editor보다 먼저 렌더한다.
- 전체 스크립트는 복사 → 수정 → 원문에서 다시 만들기, 회의록 요약은 복사 → JSON 다운로드 → 수정 → 현재 스크립트로 다시 만들기 순서를 유지한다.
- 상단 전역 `회의 작업`과 반대 탭의 action은 섞지 않는다.
- 320px에서도 wrap되고 모든 독립 control은 최소 44px target과 visible focus를 유지한다.

### R2 — 전체 스크립트 본문 교체형 수정

- `전체 스크립트 수정`을 누르면 저장된 읽기 본문은 사라지고 같은 content region이 하나의 textarea와 저장·취소 상태로 전환된다.
- 읽기 본문과 editor를 동시에 렌더하지 않는다.
- 취소 또는 확인된 discard는 draft를 버리고 수정 직전의 confirmed 본문으로 돌아간다.
- 기존 LF 정규화, non-empty, UTF-8 1 MiB 제한, 저장 결과 probe, 충돌·판정 불가 draft 보존과 focus handoff를 유지한다.

### R3 — 회의록 요약 전체 자유 본문 수정

- `회의록 요약 수정`을 누르면 현재 요약 읽기 본문 전체가 하나의 textarea로 전환된다.
- 기존 oneLine·purpose·목록·action item별 input과 추가·삭제 control은 제거한다.
- 구조화 요약의 최초 editor 값은 현재 읽기 순서와 같은 결정적 plain-text projection이다.
- `요약`, `목적`, `논의 내용`, `결정 사항`, `액션 아이템`, `리스크`, `후속 확인` 같은 본문 내 섹션 제목은 일반 텍스트라 사용자가 일부 또는 전부 삭제할 수 있다.
- 회의 표시 제목, `topicSlug`, 참석자는 이 editor에 포함하지 않고 기존 전용 writer를 유지한다.

### R4 — 자유 본문 저장과 소비자 일관성

- 기존 구조화 `summary.json`은 migration 없이 계속 읽는다.
- 수동 자유 본문 저장은 canonical summary에 optional `body`를 기록하고, `title`·`topicSlug`·`participants`를 보존하며 구조화 editable field는 비워 두어 두 정본이 공존하지 않게 한다.
- `body`는 CRLF만 LF로 정규화하고 whitespace-only 저장은 거부한다. API의 기존 512 KiB raw-body cap은 유지한다.
- content probe/success resource는 internal title·topicSlug·participants 없이 현재 `summaryBody`를 반환하고, PATCH는 exact expected pair revision과 자유 본문만 받는다.
- summary 수동 저장은 current transcript 기준 fresh manual revision이며 기존 full-pair publisher와 knowledge refresh를 그대로 사용한다.
- summary 재생성은 current transcript에서 새 구조화 요약을 만들고 optional `body`를 제거한다.
- 화면·요약 복사·combined Markdown·JSON export·knowledge card·일반 검색은 자유 본문을 현재 요약 내용으로 취급한다.
- 자유 본문에서는 action item을 추론하지 않으므로 구조화 `할 일 있음` filter는 false가 된다. 일반 텍스트 검색은 body를 검색하고 `회의록 본문` match reason을 제공한다.

### R5 — 기존 안전성·freshness·접근성 보존

- canonical transcript/summary writer는 `summarizePublisher` 하나로 유지하고 immutable raw/audio/segments는 수정하지 않는다.
- expected full-pair revision, operation lease, transcript-first/summary-last publication, network/invalid-2xx 뒤 read-only probe를 유지한다.
- transcript 변경 뒤 outdated summary 보존, summary 수동 저장·재생성 뒤 fresh 전환을 유지한다.
- dirty/saving/verifying navigation guard, editor 간 discard 확인, save conflict/ambiguous copy·recovery, generation dialog와 mutual exclusion을 유지한다.
- copy/download는 editor draft가 아니라 현재 confirmed 저장 내용을 사용한다.

### R6 — 문서와 결정적 browser 회귀

- 제품·아키텍처·UI·에이전트 문서를 action bar 위치, 본문 교체형 editor, optional body와 검색 의미에 맞춘다.
- 새 ADR 0022가 ADR 0021의 tab footer와 구조화 summary form 결정을 부분 대체한다.
- 실제 사용자 data·외부 network·Whisper·LLM 없이 desktop 1440, mobile 390, mobile 320에서 action 위치, 본문 교체, 자유 제목 삭제, cancel 복원, save/freshness와 overflow를 검증한다.

## 비목표

- 회의 표시 제목, `topicSlug`, 참석자 writer 변경
- rich text/contenteditable/WYSIWYG 또는 Markdown 파서·renderer 추가
- 자유 본문에서 섹션·action item을 다시 추론하는 parser
- autosave, 수정 이력, undo/merge UI
- 기존 모든 요약의 일괄 migration 또는 background rewrite
- 전사·요약 재생성 pipeline, provider, prompt, API-key surface 변경
- `Tabs`, `RecorderSessionProvider`, pair publisher의 기회적 리팩터
- 새 runtime 또는 test dependency

## 주요 제약

- `audio.webm`, `raw.md`, `segments.json`은 불변이다.
- `transcript.md`와 `summary.json`은 full-pair publisher만 발행한다.
- 수동 body 저장은 숨겨진 구조화 내용을 남겨 검색·내보내기에 노출하지 않는다.
- 표시 제목은 `status.titleOverride`, 참석자는 `status.review` writer를 계속 사용한다.
- browser 검증은 repository-owned pinned Playwright와 runner-owned synthetic snapshot만 사용한다.
- 실제 `data/`, `glossary.json`, `.env*`와 로컬 provider에 접근하지 않는다.

## Phase

| Phase | 이름 | 핵심 결과 | 검증 |
|---|---|---|---|
| 1 | freeform-summary-contract | optional body, deterministic projection, exact body PATCH/probe, structured-field clearing | schema·manual content·API TDD |
| 2 | freeform-summary-consumers | copy/Markdown/JSON, knowledge card, 일반 검색, chat evidence의 body 일관성 | consumer·index·search TDD |
| 3 | inline-editors-and-action-bar | tablist 직후 action bar, transcript/summary 본문 교체형 single textarea, 기존 guard/focus 보존 | RTL TDD + typecheck |
| 4 | docs-and-adr | README·정본·UI·agent 문서와 ADR 0022 | link check |
| 5 | synthetic-browser-verification | 3 viewport의 위치·전환·저장·취소·overflow 결정적 증거 | repository Playwright |

## 실행 방법

```bash
/execute inline-meeting-content-editing
```

- publish strategy는 `single-pr`이며 phase는 한 branch에 검증 가능한 commit으로 쌓는다.
- source baseline은 `main`의 `1a097292f3b2bacc300b169cddef12822c7cba44`다.
- browser preflight는 `npm run test:e2e:doctor`, 검증은 `npm run test:e2e`다.
- final gate는 전체 unit/component test, typecheck, lint, link check, build다.
- 실행 중 allowed path 밖 수정이나 실제 사용자 data 접근이 필요하면 추측해 범위를 넓히지 않고 중단한다.

## 문서 업데이트 대상

- `README.md`
- `AGENTS.md`
- `src/CLAUDE.md`
- `docs/PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/UI_GUIDE.md`
- `docs/decisions/README.md`
- 신규 `docs/decisions/0022-inline-freeform-meeting-content-editing.md`

## 고정된 가정

- 사용자가 삭제할 수 있다고 한 “타이틀”은 회의 표시 제목이 아니라 요약 본문 안의 섹션 제목이다.
- 자유 본문은 HTML이나 Markdown AST가 아닌 plain text다. 줄바꿈과 사용자가 입력한 문자는 CRLF→LF 외에는 그대로 보존한다.
- whitespace-only 요약은 저장하지 않는다.
- dirty `수정 취소`, 다른 editor 열기, route 이탈에는 기존 discard 확인을 유지한다.
- JSON 다운로드는 canonical optional `body`와 비워진 structured editable field를 그대로 포함한다.
- 수동 자유 본문 저장 뒤 `할 일 있음` filter를 위해 내용을 추측하지 않는다. 구조화 filter가 필요하면 현재 스크립트로 요약을 다시 만든다.
