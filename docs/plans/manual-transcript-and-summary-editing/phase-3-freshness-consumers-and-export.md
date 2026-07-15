# Phase 3 — freshness-consumers-and-export

contentRevision의 summary freshness와 async operation kind를 검색·질문·export·목록 DTO까지 전달한다. transcript가 바뀐 뒤 남아 있는 summary를 삭제하지 않되, 어떤 consumer도 이를 최신 요약으로 가장하지 않게 한다.

## 읽어야 할 파일

- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/decisions/0018-meeting-knowledge-index-and-chatbot.md`
- `src/domain/meeting.ts`
- `src/lib/manualMeetingContent.ts`
- `src/lib/knowledgeIndex.ts`
- `src/lib/knowledgeIndexRepository.ts`
- `src/lib/meetingSearch.ts`
- `src/lib/chatTools.ts`
- `src/lib/summaryMarkdown.ts`
- `src/lib/publicApi.ts`
- `src/lib/libraryClient.ts`
- `src/lib/summaryWork.ts`
- `src/lib/summaryWorkCache.ts`
- `src/app/api/meetings/*/export/route.ts`
- `src/lib/__tests__/knowledgeIndexRepository.test.ts`
- `src/lib/__tests__/meetingSearch.test.ts`
- `src/lib/__tests__/chatTools.test.ts`
- `src/lib/__tests__/summaryMarkdown.test.ts`
- `src/lib/__tests__/publicApi.test.ts`
- `src/lib/__tests__/libraryClient.test.ts`
- `src/lib/__tests__/summaryWork.test.ts`
- `src/app/api/__tests__/routes.integration.test.ts`

## 요구사항

- R6: outdated summary를 index/search/chat/export에서 최신으로 가장하지 않는다.
- R8: public operation/error projection이 실제 next action을 구분한다.

## 허용 범위

- `src/lib/knowledgeIndexRepository.ts`
- `src/lib/meetingSearch.ts`
- `src/lib/chatTools.ts`
- `src/lib/summaryMarkdown.ts`
- `src/lib/publicApi.ts`
- `src/lib/libraryClient.ts`
- `src/lib/summaryWork.ts`
- `src/lib/summaryWorkCache.ts`
- `src/app/api/meetings/*/export/route.ts`
- `src/lib/__tests__/knowledgeIndexRepository.test.ts`
- `src/lib/__tests__/meetingSearch.test.ts`
- `src/lib/__tests__/chatTools.test.ts`
- `src/lib/__tests__/summaryMarkdown.test.ts`
- `src/lib/__tests__/publicApi.test.ts`
- `src/lib/__tests__/libraryClient.test.ts`
- `src/lib/__tests__/summaryWork.test.ts`
- `src/app/api/__tests__/routes.integration.test.ts`

## 금지 및 중단 조건

- `data/**`
- `.env*`
- `glossary.json`
- `whisper/**`
- `src/services/**`
- `src/lib/summarizePublisher.ts`
- `src/components/**`
- outdated summary를 새 current pair hash로 knowledge card에 기록해야 하면 중단한다.
- chat이 outdated summary를 warning 없이 최신 근거로 인용해야 하면 중단한다.
- JSON export schema에 freshness field를 삽입해야 하면 중단한다.
- index 실패 때문에 canonical pair를 rollback해야 하면 중단한다.
- 실제 사용자 data 또는 외부 network가 테스트에 필요하면 중단한다.
- 허용 범위 밖 파일 수정이 필요하면 중단한다.

## 작업

1. knowledge repository의 existing source-hash freshness contract를 contentRevision과 대조한다. transcript 변경 뒤 refresh를 생략한 old card는 current transcript hash와 달라 반드시 `stale`가 되어야 한다. repository가 stale card를 corpus ready set에 다시 넣지 않게 한다.
2. meeting search가 outdated meeting을 semantic-ready로 표시하지 않고 existing `partial` + `stale` reason을 유지하게 한다. 제목·날짜 같은 안전한 metadata 결과는 기존 partial 정책 안에서 유지할 수 있지만 stale summary text를 최신 semantic hit로 승격하지 않는다.
3. chat tool의 artifact/status read에서 `summaryOutdated`를 확인한다.
   - stale summary field를 current summary evidence로 반환하거나 인용하지 않는다.
   - current transcript를 읽을 수 있는 tool은 transcript evidence와 `stale_evidence` 또는 더 구체적인 safe freshness warning을 함께 반환한다.
   - ambiguous/source conflict에서는 transcript 또는 summary를 추측해 반환하지 않는다.
4. `formatSummaryMarkdown`과 `formatMeetingMarkdown`에 explicit freshness option을 추가한다. 기본값은 기존 output과 byte-compatible하게 유지한다.
   - summary copy용 Markdown은 outdated일 때 첫 content 앞에 사람이 이해할 수 있는 warning을 포함한다.
   - combined meeting Markdown은 title 다음에 “현재 스크립트 변경 후 회의록 요약이 갱신되지 않음” warning을 포함한다.
5. export route가 artifact pair와 status content revision을 같은 safe read 흐름에서 확인한다.
   - `fmt=md`: current transcript + canonical summary를 내보내고 outdated이면 warning을 포함한다.
   - `fmt=json`: canonical summary schema를 그대로 반환해 기존 consumer를 깨지 않는다. UI가 stale 안내를 소유한다.
   - ambiguous/source conflict는 기존 내용을 plausible export로 반환하지 않는다.
6. public list/detail projection에 optional `contentOperation: initial|transcript|summary|null`을 추가한다. attempt kind mapping은 `initial → initial`, `transcript_regenerate → transcript`, `summary_regenerate|legacy resummarize → summary`, `manual_edit → null`이다.
7. 기존 `resummarizeInflight`는 client 호환을 위해 parser가 optional로 읽을 수 있으나 새 server projection과 새 UI의 정본은 `contentOperation`이다. boolean 하나로 transcript와 summary 작업을 같은 “요약 중”으로 표시하지 않는다.
8. `libraryClient` schema와 summary-work projection이 새 operation/error action을 strict하게 읽는다. transcript generation failure를 `retry_summary`로 세거나 요약 재시도를 제안하지 않는다.
9. summary-work cold-entry reconciliation은 모든 durable content attempt를 reconcile하되 manual_edit를 global “요약 작업 중” count로 노출하지 않는다. transcript/summary generation은 종류별 safe status를 유지한다.
10. consumer/index failure는 safe log만 남기고 canonical pair 또는 freshness metadata를 rollback하지 않는다. raw content, path, attempt ID는 log/public DTO에 넣지 않는다.

## 테스트 (먼저 작성)

- Knowledge RED: transcript hash가 바뀌고 card refresh가 없으면 card/corpus가 stale이며 ready로 복귀하지 않는다.
- Fresh recovery RED: summary가 current transcript에 다시 묶이고 refresh되면 card/corpus가 ready가 된다.
- Search RED: outdated meeting은 partial/stale reason을 가지며 stale summary semantic projection을 ready hit로 반환하지 않는다.
- Chat RED: outdated summary를 current evidence로 반환하지 않고 current transcript 사용 시 freshness warning을 포함한다. ambiguous/source conflict는 unavailable이다.
- Markdown RED: fresh default output은 regression fixture와 같고 outdated summary/meeting Markdown만 명시적 warning을 포함한다.
- Export RED: fresh/stale Markdown, unchanged JSON schema, ambiguous/source conflict safe error, titleOverride/participants 보존을 검증한다.
- Public DTO RED: attempt kind별 contentOperation mapping과 manual_edit exclusion, safe retry action을 검증한다.
- Client schema RED: new contentOperation을 읽고 legacy optional boolean payload도 crash 없이 읽는다.
- Summary-work RED: transcript generation, summary generation, manual edit, retry_transcript_generation, retry_summary를 올바른 bucket과 next action으로 분류한다.
- Non-rollback RED: index/search/corpus failure가 content pair와 contentRevision을 바꾸지 않는다.

## 문서 최신화

- 이 phase에서는 정본 문서를 수정하지 않는다. public DTO와 Markdown warning option의 source comment만 실제 계약과 맞춘다.
- 사용자 용어와 consumer 정책은 phase 7에서 갱신한다.

## 완료 게이트

```bash
npm test -- src/lib/__tests__/knowledgeIndexRepository.test.ts src/lib/__tests__/meetingSearch.test.ts src/lib/__tests__/chatTools.test.ts src/lib/__tests__/summaryMarkdown.test.ts
npm test -- src/lib/__tests__/publicApi.test.ts src/lib/__tests__/libraryClient.test.ts src/lib/__tests__/summaryWork.test.ts src/app/api/__tests__/routes.integration.test.ts
npm run typecheck
```
