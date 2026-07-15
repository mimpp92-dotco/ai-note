# Plan — manual-transcript-and-summary-editing

요약 완료 후 사용자가 **교정된 전체 스크립트와 화면에 보이는 회의록 요약을 각각 직접 수정**할 수 있게 한다. 최초 생성만 `raw.md → transcript.md → summary.json` 순서로 자동 실행하고, 이후 재생성은 전체 스크립트와 회의록 요약을 서로 독립된 단계로 분리한다.

## 배경/목표

Whisper와 LLM 교정·요약은 100% 정확하지 않다. 현재 앱은 전체 스크립트와 요약을 열람·재생성할 수 있지만, 사용자가 잘못된 고유명사·숫자·결정·액션 아이템을 직접 바로잡을 수 없고 `다시 요약` 한 동작이 교정본과 요약을 함께 바꾼다.

이번 기능은 다음 소유권을 고정한다.

```text
불변 원문(raw.md)
  └─ 원문에서 스크립트 다시 만들기
       → 전체 스크립트(transcript.md, 직접 수정 가능)
          └─ 현재 스크립트로 요약 다시 만들기
               → 회의록 요약(summary.json, 직접 수정 가능)
```

1. 최초 회의록 생성 시에만 raw 교정과 요약 생성을 순차 실행해 두 canonical artifact를 만든다.
2. 전체 스크립트 탭의 `원문에서 스크립트 다시 만들기`는 immutable raw에서 교정본만 새로 만들고 요약 LLM을 호출하지 않는다.
3. 회의록 요약 탭의 `현재 스크립트로 요약 다시 만들기`는 현재 canonical 스크립트로 요약만 새로 만들고 correction LLM을 호출하지 않는다.
4. 전체 스크립트가 바뀌면 기존 요약은 보존하되 `요약 갱신 필요`로 표시한다.
5. 현재 스크립트로 요약을 다시 만들거나 요약을 직접 수정해 저장하면 요약이 최신 상태가 된다.

## 합의된 requirements

- **R1 — 원본 불가침과 최초 생성**: `audio.webm`·`raw.md`·`segments.json`은 수정하지 않는다. 최초 생성만 raw → corrected transcript → summary 전체 파이프라인을 자동 실행한다.
- **R2 — 전체 스크립트 직접 수정**: 안정적인 corrected transcript를 textarea에서 수정하고 명시적으로 저장·취소한다. 저장 실패·충돌·결과 확인 중에는 draft와 focus를 보존한다.
- **R3 — 회의록 요약 전체 수정**: 한 줄 요약, 목적, 핵심, 논의, 결정, 액션 아이템, 리스크, 후속 확인을 손실 없는 구조화 폼으로 수정한다.
- **R4 — 독립 재생성**: 전체 스크립트 재생성은 raw 교정만, 회의록 요약 재생성은 현재 transcript 요약만 실행하며 서로의 artifact를 자동 재생성하지 않는다.
- **R5 — durable pair 발행·복구·저장 확인**: 모든 content mutation은 기존 summarize pair publisher, durable attempt, expected pair revision, artifact lease, restart reconciliation을 사용한다. 응답 유실 시 read-only probe로 실제 저장 결과를 확인한다.
- **R6 — 요약 freshness와 consumer 정합**: summary가 어느 transcript hash를 바탕으로 했는지 기록한다. outdated summary를 상세·복사·export·검색·질문에서 최신으로 가장하지 않는다.
- **R7 — 버튼 위계**: 두 탭과 무관한 작업만 상세 최상단에 두고, 스크립트 전용 작업과 요약 전용 작업은 각각 해당 탭 하단 action footer에 둔다.
- **R8 — 오류·이탈·접근성 UX**: validation, busy, revision conflict, 결과 확인 중, durability pending, interrupted, ambiguous를 구분하고 unsaved navigation guard와 파괴 동작 확인을 제공한다.
- **R9 — synthetic browser QA**: 실제 사용자 data를 읽지 않는 격리된 임시 snapshot으로 desktop/mobile action hierarchy, stale 안내, focus, navigation guard, overflow를 검증한다.
- **R10 — 문서화**: 제품·아키텍처·UI 문서와 새 ADR 0021을 독립 생성 파이프라인·freshness·오류·버튼 위계 계약에 맞춘다.

## 브라우저 검증 원칙

- 결정적 synthetic QA의 필수 backend는 repository가 exact version으로 소유한 Playwright와 matching Chromium이다. `npm run test:e2e:doctor`가 준비 상태를 read-only로 확인하고 `npm run test:e2e`가 실제 완료 gate를 수행한다.
- Chrome DevTools MCP는 기존 로그인·tab·extension 상태가 필요한 정성 탐색이나 사람이 보면서 확인하는 추가 점검에만 선택적으로 쓴다. `/execute` preflight, synthetic fixture, screenshot manifest, 완료 판정의 필수 조건도 아니고 Playwright의 fallback도 아니다.
- Phase 5가 synthetic fixture와 feature spec을 제품 변경과 함께 커밋한다. 최초 Phase 6 verify-only 실행에서 TypeScript spec의 ESM fixture static import가 Playwright loader에서 실패해, amended Phase 6이 해당 spec 한 파일의 module-loading 경계만 TDD로 복구한 뒤 이미 커밋된 browser suite 전체를 실행한다.
- Playwright는 `ai-note`에 이미 설치된 개발 의존성이다. 새 clone에서는 `npm install` 뒤 browser binary를 한 번 `npm run test:e2e:install`로 준비한다. 실행 중 자동 다운로드나 package mutation은 하지 않는다.
- Next.js나 앱 코드가 바뀔 때마다 Chrome DevTools MCP adapter를 보수하지 않는다. Browser revision 변경은 exact `@playwright/test` version을 의도적으로 올리고 lockfile 갱신 → matching browser 설치 → doctor → 전체 E2E 순서로 검증할 때만 발생한다.
- 모든 browser test는 OS temp의 runner-owned source snapshot과 synthetic library만 사용한다. 실제 workspace `data/`, `.env*`, `glossary.json`, 실행 중인 dev server, Whisper, LLM, 외부 network는 사용하지 않는다.

## 데이터·상태 계약

### Canonical pair와 content revision

- `transcript.md`와 `summary.json`은 계속 하나의 generation-consistent pair다. 한쪽만 바꾸는 작업도 변경하지 않는 다른 artifact를 같은 pair publisher에 넘겨 mixed generation을 만들지 않는다.
- canonical writer는 계속 `src/lib/summarizePublisher.ts` 하나다.
- `status.json`에 optional `contentRevision`을 추가한다.

```ts
contentRevision?: {
  transcript: {
    source: "generated" | "manual";
    sha256: string;
    updatedAt: string;
  };
  summary: {
    source: "generated" | "manual";
    sha256: string;
    basedOnTranscriptSha256: string;
    updatedAt: string;
  };
}
```

- stable legacy pair에 이 필드가 없으면 읽기 시 generated transcript/generated summary이며 current transcript에 기반한 fresh pair로 해석한다. 첫 content mutation이 full metadata를 materialize한다.
- recorded transcript/summary hash가 canonical pair와 다르면 freshness를 추측하지 않고 fail-closed한다.
- `summaryOutdated`는 `summary.basedOnTranscriptSha256 !== transcript.sha256`으로 파생한다. 별도 boolean을 정본으로 저장하지 않는다.
- transcript hash가 바뀌는 수동 저장·raw 재교정은 summary metadata를 그대로 보존하므로 summary가 outdated가 된다. 새 hash가 이전과 동일하면 fresh 상태도 그대로다.
- summary 수동 저장·재생성은 current transcript hash를 `basedOnTranscriptSha256`로 기록해 fresh 상태를 만든다.

### Durable attempt와 operation

- legacy 필드명 `summarizeAttempt`는 기존 status·publisher 호환을 위해 유지하되 다음 kind를 이해한다.
  - `initial`: raw correction + summary, 두 artifact 생성.
  - `transcript_regenerate`: raw correction만 실행하고 기존 summary를 보존.
  - `summary_regenerate`: current transcript로 summary만 생성.
  - `manual_edit`: transcript 또는 summary의 직접 저장.
  - legacy `resummarize`: restart recovery에서 계속 읽으며 새 요청은 `summary_regenerate`로 기록.
- 새 `manual_edit|transcript_regenerate|summary_regenerate` attempt와 manifest는 publication 후 적용할 transcript/summary source와 summary base transcript hash를 durable하게 가진다. 기존 코드가 만든 legacy `initial|resummarize` attempt에 이 metadata가 없으면 publisher가 intended pair hash에서 generated/fresh revision을 결정해 하위 호환하며, live publish와 restart reconciliation은 같은 `contentRevision`을 만든다.
- 모든 content mutation은 서로, summarize reconciliation, delete, cleanup과 충돌한다. 목록·상세에는 `initial | transcript | summary`의 실제 진행 종류를 공개하고 manual save를 `요약 중`으로 가장하지 않는다. 새 operation DTO 전환 전의 legacy boolean도 manual_edit를 제외한다.
- manual edit가 publication 전에 중단되면 old pair·기존 `contentRevision`·기존 error·`summarizeAttempts`를 그대로 유지하고 attempt만 정리한다. `retry_summary` 오류나 LLM 실패 횟수를 만들지 않는다.
- rename 뒤 directory sync pending은 logical commit이다. rollback하거나 같은 mutation을 자동 재전송하지 않는다.

## API 계약

### Read-only current-content probe

```http
GET /api/meetings/{id}/content
```

stable pair에서 다음 safe resource를 `cache-control: no-store`로 반환한다.

```json
{
  "transcript": "현재 교정 스크립트",
  "summary": {
    "oneLine": "한 줄 요약",
    "purpose": "목적",
    "highlights": [],
    "discussion": [],
    "decisions": [],
    "actionItems": [],
    "risks": [],
    "followups": []
  },
  "revision": {
    "transcriptSha256": "64-char sha256",
    "summarySha256": "64-char sha256"
  },
  "transcriptSource": "generated",
  "summarySource": "generated",
  "summaryOutdated": false,
  "pairState": "stable"
}
```

- internal `title`, `topicSlug`, `summary.participants`, path, attempt ID, filesystem/provider output은 반환하지 않는다.
- missing/interrupted/ambiguous를 서로 다른 safe code로 반환한다.
- client는 network error 또는 invalid 2xx save body 뒤 이 endpoint로 intended normalized content와 current pair를 비교한다.

### 수동 편집

```http
PATCH /api/meetings/{id}/transcript
PATCH /api/meetings/{id}/summary
```

두 route는 local guard → safe meeting ID → tombstone fence → bounded exact JSON → content operation → artifact read/write lease 순서를 지킨다.

Transcript body는 최대 2 MiB JSON이고 normalized transcript는 UTF-8 1 MiB 이하·비어 있지 않아야 한다.

```json
{
  "expectedRevision": {
    "transcriptSha256": "64-char sha256",
    "summarySha256": "64-char sha256"
  },
  "transcript": "사용자가 수정한 교정 스크립트"
}
```

Summary body는 최대 512 KiB exact JSON이다. `title`, `topicSlug`, `participants`는 받지 않고 canonical 값에서 보존한다.

```json
{
  "expectedRevision": {
    "transcriptSha256": "64-char sha256",
    "summarySha256": "64-char sha256"
  },
  "summary": {
    "oneLine": "한 줄 요약",
    "purpose": "목적",
    "highlights": ["핵심"],
    "discussion": ["논의"],
    "decisions": ["결정"],
    "actionItems": [{"owner": "담당자", "task": "할 일", "due": "기한"}],
    "risks": ["리스크"],
    "followups": ["후속 확인"]
  }
}
```

### 독립 재생성

```http
POST /api/meetings/{id}/transcript/regenerate
POST /api/meetings/{id}/summarize
```

- transcript route body는 strict `{expectedRevision, confirmReplacement:true}`다. raw → correction 한 번만 실행하고 summary adapter call은 0회다. 새 transcript와 기존 summary를 pair로 발행한다.
- summarize route의 `{resummarize:true, expectedRevision}`는 current transcript → summary만 실행하고 correction adapter call은 0회다. 기존 transcript bytes를 그대로 pair에 넣는다.
- 기존 global `POST /api/summarize`의 `resummarize:true`는 CLI 호환을 위해 current stable pair를 acceptance 시점에 snapshot하고 summary-only regeneration으로 해석한다. raw correction을 다시 실행하지 않는다.
- 최초 worker/CLI summarize는 summary가 없을 때만 기존 raw correction + summary 전체 파이프라인을 실행한다.
- transcript replacement와 summary replacement는 각각 별도 확인을 거친다. API가 UI 확인만 신뢰하지 않도록 transcript replacement request는 exact confirmation flag를 요구한다.
- 두 async route는 durable attempt commit 뒤 202를 반환하고 client는 공개된 operation kind를 폴링한다. 동일 내용 결과도 operation 해제로 완료를 판정한다.

### Safe 오류 구분

- `content_revision_conflict`(409): current pair가 expected pair와 다름.
- `content_operation_in_progress`(409): 다른 content mutation/reconciliation이 진행 중.
- `content_source_conflict`(409): recorded revision/provenance와 canonical hash가 모순됨.
- `content_state_ambiguous`(409): old/new pair를 안전하게 판정할 수 없음.
- `content_save_unavailable`(503): 저장을 시작하거나 결과를 확인할 수 없는 local I/O 상태.
- 기존 `invalid_request`, `request_body_too_large`, `meeting_not_found`, `meeting_deleted`는 유지한다.
- public error는 safe field/operation만 제공하고 path, raw content, attempt ID, provider/fs output을 노출하지 않는다.
- transcript generation 실패는 `retry_transcript_generation`, summary generation 실패는 `retry_summary`로 분리해 각각 해당 tab action만 복구 대상으로 안내한다.

## 저장 결과 확인 UX

| 상태 | 사용자에게 보이는 결과 | 허용 행동 |
|---|---|---|
| validation/413 | `저장되지 않음 · 입력 유지`와 field 오류 | 수정 후 저장 |
| content operation busy | 다른 content 작업 종류와 대기 안내 | 완료 확인 |
| revision conflict | `다른 저장으로 내용이 변경됨 · 입력 유지` | 내 입력 복사, 최신 내용 불러오기 |
| network/invalid 2xx | `저장 여부 확인 중` | 자동 PATCH 금지, GET probe |
| probe=new intended | `저장됨` | editor 종료 |
| probe=old expected | `저장되지 않음 · 기존 내용 유지` | 같은 draft로 명시적 재시도 |
| probe=third revision | conflict | 내 입력 복사, 최신 내용 불러오기 |
| durability pending | `저장됨 · 디스크 동기화 확인 대기` | 자동 재전송 금지 |
| interrupted old pair | `저장이 완료되지 않아 기존 내용을 유지함` | 같은 draft로 재시도 |
| ambiguous | `저장 상태를 안전하게 확인할 수 없음` | 편집 잠금, 새로고침, 데이터 폴더 열기 |

- valid success 또는 probe로 확정한 `confirmedRevision`과 그 직전 `predecessorRevision`을 client snapshot에 함께 둔다. 뒤늦게 도착한 server props가 predecessor와 같으면 무시하고 최신 저장본을 되돌리지 않는다.
- pristine 상태에서 둘 다 아닌 third revision이 들어오면 단순히 “더 최신”으로 가정하지 않는다. no-store content probe가 같은 revision을 현재 canonical pair로 확인한 경우에만 외부 변경으로 수용하고, 불일치·확인 실패 시 기존 confirmed snapshot을 유지한 채 충돌/확인 불가 안내를 표시한다.

## 버튼 위계와 탭 UX

### 상세 최상단 — global action

두 탭 중 하나에만 속하지 않는 작업만 둔다.

- `회의 이동`
- `폴더 열기`
- `Markdown 다운로드`: summary + current transcript를 포함하는 전체 회의 hand-off 문서.

### 전체 스크립트 탭 하단

`전체 스크립트 작업` action footer를 content 뒤에 둔다.

- `전체 스크립트 복사`
- `전체 스크립트 수정`
- `원문에서 스크립트 다시 만들기`

재생성 확인은 “최초 자동 전사 원문을 기준으로 교정본을 다시 만들며 현재 스크립트 수정 내용이 대체된다”는 점과 “기존 요약은 유지되지만 갱신 필요 상태가 될 수 있다”는 점을 설명한다. Cancel이 initial focus다.

### 회의록 요약 탭 하단

`회의록 요약 작업` action footer를 content 뒤에 둔다.

- `요약 복사`
- `JSON 다운로드`
- `회의록 요약 수정`
- `현재 스크립트로 요약 다시 만들기`

재생성 확인은 현재 스크립트가 입력이며 transcript는 바뀌지 않고 수동 summary 수정은 대체된다는 점을 설명한다. Cancel이 initial focus다.

### Freshness 표시

- transcript 변경 뒤 summary tab label과 panel에 `요약 갱신 필요`를 텍스트로 표시한다.
- stale summary는 계속 열람·직접 수정할 수 있다. summary copy는 경고를 포함하고 JSON download는 schema를 바꾸지 않되 연결된 안내로 stale임을 알린다.
- 전체 Markdown download는 stale이면 문서 안에도 “현재 스크립트 변경 후 요약이 갱신되지 않음” 경고를 넣는다.
- mutation 중 read-only copy/download는 현재 저장된 내용임을 명확히 하고, 모든 content mutation은 서로 disabled된다.

## Consumer freshness

- transcript가 바뀌어 summary가 outdated가 되면 knowledge card를 새 pair hash로 refresh하지 않는다. 기존 card는 transcript source hash mismatch로 stale/partial이 된다.
- summary 수동 저장 또는 summary regeneration으로 fresh가 되면 card와 corpus-map refresh를 시도한다.
- index 실패·partial·pending은 canonical content를 rollback하지 않는다.
- search는 outdated summary 기반 semantic result를 ready로 표시하지 않는다.
- chat tool은 stale summary를 최신 근거로 인용하지 않고 current transcript를 사용할 수 있을 때 freshness warning을 함께 반환한다.
- combined Markdown export는 warning을 포함한다. JSON export는 canonical summary schema를 그대로 유지한다.

## Unsaved navigation guard

- dirty editor는 sidebar, 목록 link, programmatic router, browser back/forward, beforeunload 이탈을 보호한다.
- content-only guard의 initial focus는 `계속 편집`, destructive action은 `수정 내용 버리고 이동`이다.
- 저장 또는 결과 확인 중에는 commit 여부가 모호해질 수 있으므로 이탈과 discard를 막고 현재 화면에 머무르게 한다.
- unsaved audio와 content draft가 동시에 있으면 하나의 dialog에서 둘 다 명시하고, 둘을 함께 버리는 단일 destructive action 전에는 이동하지 않는다.
- 취소·Escape는 connected trigger로 focus를 돌린다. tab 전환은 navigation이 아니므로 draft를 parent에 보존한다.

## 요약 편집 폼

- `oneLine`과 `purpose`는 labeled textarea다.
- highlights, discussion, decisions, risks, followups는 **항목별 반복 textarea**로 렌더해 한 항목 안의 개행을 보존한다. 항목 추가·삭제는 지원하고 drag-and-drop·별도 reorder UI는 추가하지 않는다.
- action item은 owner/task/due 반복 행과 추가·삭제 control을 제공한다.
- 빈 항목은 저장하지 않되 기존 multiline 항목을 줄 단위로 분해하지 않는다.
- title/topicSlug/participants field는 렌더하지 않는다. titleOverride와 참석자는 기존 전용 writer를 유지한다.

## Non-goals

- `raw.md`, `segments.json`, audio, timestamp 수정 또는 새 timestamp alignment.
- raw와 corrected transcript의 diff/merge UI, 버전 이력, undo history, server autosave.
- 회의 제목·참석자 편집 UX 재설계, 내부 `topicSlug`·`summary.participants` 편집.
- AI 보조 문장 편집, batch 편집, 협업, cloud sync.
- summary 항목 drag-and-drop reorder.
- 검색 ranking 변경, provider/API key/LLM adapter 변경, 유료 API 호출.
- 새 runtime 또는 UI dependency 추가.
- 초기 생성 이후 raw correction과 summary를 한 버튼으로 다시 실행하는 legacy combined UI.

## 주요 제약

- 원본·단일 writer·tombstone·atomic/durable commit·summary-last completion marker·lock order는 AGENTS와 ADR 0013을 그대로 따른다.
- 모든 data API는 params/body/fs/network/spawn보다 먼저 local request guard를 통과한다.
- 실제 사용자 `data/`, `.env*`, `glossary.json`은 테스트·fixture·browser QA에 사용하지 않는다.
- build는 secret/DB/env 없이 통과한다.
- 새 dependency와 유료 API 호출은 없다.

## Phase 표

| # | 이름 | 요구사항 | 핵심 범위 | 검증 |
|---|---|---|---|---|
| 1 | content-revision-manual-edit-and-probe | R1, R2, R3, R5, R6, R8 | contentRevision, pair revision, manual publisher/recovery, GET probe, PATCH routes, safe errors | domain/lib/API TDD |
| 2 | independent-transcript-and-summary-generation | R1, R4, R5, R6 | initial/transcript/summary generation 분리, exact LLM call counts, async operation kind | generation/API TDD |
| 3 | freshness-consumers-and-export | R6, R8 | index stale policy, search/chat warning, Markdown/JSON, public operation DTO | consumer/API TDD |
| 4 | detail-action-hierarchy-and-editors | R2, R3, R4, R6, R7, R8 | global/tab footer 위계, editors, probe/conflict, stale banner, confirmations | RTL + build |
| 5 | unsaved-edit-navigation-guard | R7, R8, R9 | generic blocker, audio+content guard, committed synthetic fixture·Playwright feature spec | RTL + harness TDD |
| 6 | synthetic-browser-qa | R7, R8, R9 | Playwright spec 단일 파일 module-loading repair, temp snapshot desktop/mobile hierarchy·focus·overflow·guard | TDD + browser evidence |
| 7 | docs-adr-and-final-contract | R10 | README·정본·UI·ADR 0021 | links |

## 실행 방법

```bash
/execute manual-transcript-and-summary-editing
```

- publishStrategy: `single-pr`
- Phase는 검증 가능한 checkpoint이며 구현 phase는 TDD 증거를 남긴다.
- source baseline은 Playwright harness와 execute-worktree dependency resolution이 검증·커밋된 `4ca1db3fef0a1936fc7cc71ee995448306cd4164`이다. 그 뒤에는 이 plan directory만 바뀔 수 있으며 `/execute` preflight가 다른 delta를 거부한다.
- browser phase는 repository 밖 격리된 temporary snapshot과 synthetic meeting만 사용한다. amended Phase 6의 허용된 spec 한 파일 밖을 수정하거나 실제 workspace `data/`에 접근해야 하면 중단한다.
- 새 세션에서 실행 전 `npm run test:e2e:doctor`로 local Chromium 준비 상태를 확인할 수 있다. 실패하면 `npm run test:e2e:install`을 명시적으로 한 번 실행한 뒤 다시 확인한다.
- finalGate: `npm test` · `npm run typecheck` · `npm run lint` · `npm run build` · `npm run check:links`
- `/execute` 전 worktree는 깨끗해야 한다. 이 plan 개정 커밋 뒤에는 clean 상태를 다시 확인하고 실제 실행은 사용자가 새 세션에서 시작한다.

## 문서 업데이트 대상

- `README.md`
- `AGENTS.md`
- `src/CLAUDE.md`
- `docs/PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/UI_GUIDE.md`
- `docs/decisions/README.md`
- 신규 `docs/decisions/0021-manual-transcript-and-summary-editing.md`

## 고정된 가정

- 회의 제목과 참석자는 새 summary 편집 폼에 합치지 않고 기존 전용 저장 surface를 유지한다.
- transcript를 직접 수정하거나 raw에서 다시 만들면 summary는 자동 생성하지 않고 outdated로 남긴다.
- summary를 직접 저장한 행위는 사용자가 current transcript에 맞게 검토·수정했다는 명시적 확인으로 보고 fresh로 묶는다.
- stale summary는 숨기거나 삭제하지 않고 경고와 갱신 action을 제공한다.
- combined Markdown은 global action, JSON은 summary-specific action이다.
