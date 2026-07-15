# Phase 1 — content-revision-manual-edit-and-probe

수동 transcript/summary 저장을 기존 generation-consistent pair publisher 위에 올리고, transcript와 summary의 provenance·freshness·pair revision·restart recovery를 durable하게 고정한다. 응답 유실 뒤 현재 canonical pair를 확인할 read-only probe와 typed public error까지 TDD로 만든다.

## 읽어야 할 파일

- `AGENTS.md`
- `src/CLAUDE.md`
- `docs/ARCHITECTURE.md`
- `docs/decisions/0013-durable-summarize-pair-publication.md`
- `docs/decisions/0018-meeting-knowledge-index-and-chatbot.md`
- `src/domain/meeting.ts`
- `src/domain/library.ts`
- `src/domain/summarySchema.ts`
- `src/domain/summary.ts`
- `src/lib/artifactPair.ts`
- `src/lib/artifactLease.ts`
- `src/lib/meetingLifecycle.ts`
- `src/lib/summarizePublisher.ts`
- `src/lib/knowledgeIndexRepository.ts`
- `src/lib/localRequestGuard.ts`
- `src/lib/publicApi.ts`
- `src/app/api/meetings/*/review/route.ts`
- `src/app/api/meetings/*/summarize/route.ts`
- `src/lib/__tests__/summarizePublisher.test.ts`
- `src/lib/__tests__/artifactPair.test.ts`
- `src/lib/__tests__/meetingLifecycle.test.ts`
- `src/lib/__tests__/publicApi.test.ts`
- `src/app/api/__tests__/routes.integration.test.ts`
- `src/app/api/__tests__/tombstoneFence.test.ts`
- `src/lib/__tests__/localRequestGuard.test.ts`

## 요구사항

- R1: immutable 원본은 건드리지 않고 stable corrected pair만 편집 대상으로 삼는다.
- R2: bounded corrected transcript 수동 저장과 manual provenance를 제공한다.
- R3: user-facing summary field의 손실 없는 수동 저장과 manual provenance를 제공한다.
- R5: durable pair publication, expected revision, restart recovery, GET probe를 제공한다.
- R6: contentRevision과 summaryOutdated 파생 계약을 만든다.
- R8: typed error와 interrupted/pending/ambiguous 결과를 안전하게 구분한다.

## 허용 범위

- `src/domain/meeting.ts`
- `src/domain/library.ts`
- `src/domain/summarySchema.ts`
- `src/domain/summary.ts`
- `src/lib/artifactPair.ts`
- `src/lib/meetingLifecycle.ts`
- `src/lib/summarizePublisher.ts`
- `src/lib/manualMeetingContent.ts`
- `src/lib/localRequestGuard.ts`
- `src/lib/publicApi.ts`
- `src/app/api/meetings/*/content/route.ts`
- `src/app/api/meetings/*/transcript/route.ts`
- `src/app/api/meetings/*/summary/route.ts`
- `src/domain/__tests__/library.test.ts`
- `src/domain/__tests__/summarySchema.test.ts`
- `src/lib/__tests__/artifactPair.test.ts`
- `src/lib/__tests__/meetingLifecycle.test.ts`
- `src/lib/__tests__/publicApi.test.ts`
- `src/lib/__tests__/summarizePublisher.test.ts`
- `src/lib/__tests__/manualMeetingContent.test.ts`
- `src/lib/__tests__/localRequestGuard.test.ts`
- `src/app/api/__tests__/routes.integration.test.ts`
- `src/app/api/__tests__/tombstoneFence.test.ts`

## 금지 및 중단 조건

- `data/**`
- `.env*`
- `glossary.json`
- `whisper/**`
- `src/services/**`
- `src/lib/status.ts`
- `src/lib/knowledgeIndex.ts`
- `src/lib/knowledgeIndexRepository.ts`
- `src/lib/meetingSearch.ts`
- `src/lib/chatTools.ts`
- audio.webm, raw.md, segments.json 중 하나라도 수정해야 하면 중단한다.
- summarizePublisher 외 코드가 canonical transcript.md 또는 summary.json을 직접 써야 하면 중단한다.
- expected pair revision 없이 stale client write를 허용해야 하면 중단한다.
- manual_edit interruption을 retry_summary 또는 summarizeAttempts 증가로 표시해야 하면 중단한다.
- save 결과 확인을 위해 mutation을 자동 재전송해야 하면 중단한다.
- 수동 저장에 LLM, 외부 network, 새 dependency가 필요하면 중단한다.
- 허용 범위 밖 파일 수정이 필요하면 중단한다.

## 작업

1. `StatusJson`과 runtime parser에 strict optional `contentRevision`을 추가한다.
   - transcript: `source generated|manual`, current canonical SHA-256, updatedAt.
   - summary: `source generated|manual`, current canonical SHA-256, `basedOnTranscriptSha256`, updatedAt.
   - stable legacy pair에 필드가 없으면 read model에서 generated/fresh virtual revision으로 해석하되 read만으로 status를 쓰지 않는다.
   - metadata hash와 canonical pair가 모순되면 legacy fallback을 적용하지 않고 source conflict로 판정한다.
2. `SummarizeAttempt.kind`와 manifest schema가 `manual_edit`, `transcript_regenerate`, `summary_regenerate`를 읽게 하고 legacy `initial|resummarize`와 호환한다. 새 세 kind에는 intended content revision을 필수로 담는다. 기존 `summarize.ts`가 만든 legacy initial/resummarize attempt에 새 field가 없으면 intended pair hash로 generated transcript/generated summary/current transcript base를 결정해 phase 1 단독으로도 기존 생성 경로가 계속 통과하게 한다. live publication과 restart completion은 같은 metadata를 commit한다.
3. `artifactPair.ts`가 한 artifact read lease 안에서 transcript/summary text, 두 SHA-256 pair revision, validated content revision, derived `summaryOutdated`를 함께 반환하게 한다. missing, interrupted, ambiguous와 source conflict를 stable pair로 가장하지 않는다.
4. `summarizePublisher`의 success clear가 intended full content revision을 같은 status commit에 설정한다. transcript-first/summary-last와 preimage 복구는 유지한다.
5. manual edit 전용 interrupted branch를 추가한다. publication 전 old pair 또는 restored old pair가 확인되면 attempt만 정리하고 status, prior error, `summarizeAttempts`, 기존 content revision을 byte-for-byte 의미상 보존한다. `summary_interrupted`·`retry_summary`를 만들지 않는다.
6. `meetingLifecycle.ts`에 exact `manual_edit`, `transcript_regenerate`, `summary_regenerate` operation을 추가하고 모두 같은 content mutation group으로 직렬화한다. `summarize_reconcile`, delete, cleanup과 충돌하며 status/move의 기존 compatibility는 유지한다. live manual operation을 orphan attempt로 오인하지 않는다.
7. 수동 편집 strict schema를 추가한다.
   - summary body는 editable field만 받고 unknown/internal field를 reject한다.
   - string array item은 item 단위 trim/non-empty 정책만 적용하고 내부 개행을 분해하지 않는다.
   - action item은 기존 schema를 재사용한다.
8. `manualMeetingContent.ts`를 신설한다. operation → stable pair/status/content revision 확인 → expected pair compare → normalized next full pair/next content revision 구성 → durable attempt commit → publisher 순서를 소유한다.
   - transcript save: LF, non-empty, UTF-8 1 MiB. source manual. 기존 summary bytes와 summary metadata를 보존한다. transcript hash가 바뀌면 derived outdated가 된다.
   - summary save: canonical title/topicSlug/participants 보존, full Summary 재검증, source manual, current transcript hash에 기반한 fresh summary로 기록한다.
   - transcript가 실제 동일하면 summary freshness를 불필요하게 stale로 만들지 않는다.
   - fresh summary 성공 뒤에만 existing `refreshAfterSummary`를 호출한다. transcript change로 outdated가 되면 refresh하지 않아 기존 card가 hash mismatch로 stale가 되게 한다.
9. acceptance status commit이 pending이면 artifact publish를 시작하지 않는다. publisher error는 hash reconciliation으로 completed, old pair, interrupted, ambiguous를 판정하고 추측해 덮지 않는다.
10. `GET /api/meetings/[id]/content`를 추가한다. local guard와 tombstone fence 뒤 stable pair를 읽고 editable summary projection, transcript, pair revision, source, summaryOutdated, pairState만 반환한다. raw path, internal summary field, content revision timestamps, attempt ID, filesystem/provider output은 숨긴다.
11. 두 PATCH route를 추가한다. exact JSON cap은 transcript 2 MiB, summary 512 KiB다. result를 success, field validation, body-too-large, not-found/deleted, `content_revision_conflict`, `content_operation_in_progress`, `content_source_conflict`, `content_state_ambiguous`, `content_save_unavailable`로 매핑한다.
12. `publicApi.ts`에 위 safe code와 정적 한국어 message를 추가한다. details는 기존 allowlist 경계에서 safe `field`와 bounded `operation`만 허용한다. domain `ErrorAction`에는 transcript generation 전용 `retry_transcript_generation`을 추가하고 strict parser/public projection이 이를 보존하되 summary 실패의 `retry_summary`와 섞지 않는다. 새 `contentOperation` DTO는 phase 3 소관이지만, 기존 `resummarizeInflight` boolean은 이 phase부터 manual_edit를 제외해 수동 저장을 `요약 중`으로 가장하지 않는다.
13. 세 route를 `DATA_SURFACE_INVENTORY`에 등록하고 unsafe Origin, exact content type, body-before-fence 금지 규칙을 우회하지 않는다. GET은 request body를 읽지 않는다.

## 테스트 (먼저 작성)

- Domain RED: legacy status round-trip, strict contentRevision, 새/legacy attempt kind, new-kind intended metadata 필수, legacy metadata 부재 허용, malformed source/hash/base/unknown field 거부를 검증한다.
- Pair RED: 한 read lease의 text와 hashes가 같은 generation이고 legacy virtual fresh, manual stale/fresh, source conflict, mixed/ambiguous를 정확히 판정한다.
- Publisher RED: 각 new kind가 transcript-first/summary-last로 발행되고 live/crash recovery 뒤 intended full contentRevision을 기록한다. metadata 없는 legacy initial/resummarize도 기존 summarize code 변경 없이 generated/fresh revision으로 성공한다.
- Manual interruption RED: pre-staging/pre-publication crash는 old pair/revision/error/summarizeAttempts를 보존하고 retry_summary를 만들지 않는다. partial transcript는 restore 뒤 같은 의미를 갖는다.
- Transcript service RED: raw/segments/summary bytes를 바꾸지 않고 transcript/manual revision만 갱신하며 hash change에서 outdated, identical hash에서 기존 freshness를 유지한다.
- Summary service RED: transcript bytes/source와 internal summary field를 보존하고 editable fields/manual summary revision/current transcript base를 기록해 fresh가 된다.
- Lossless schema RED: multiline list item을 하나의 item으로 유지하고 빈 item/unknown/internal field를 거부한다.
- Conflict RED: expected pair 한쪽 stale, active content operation, provenance mismatch, ambiguous pair는 artifact/status/index write 0회다.
- Public inflight RED: legacy boolean은 initial/resummarize/transcript/summary generation에는 true, manual_edit에는 false다.
- Error action RED: `retry_transcript_generation`이 strict status round-trip과 safe public projection을 통과하고 unknown action은 거부되며 `retry_summary` 의미를 바꾸지 않는다.
- Index policy RED: transcript change/outdated에는 refresh 0회, fresh summary save에는 1회이며 index failure가 content success를 rollback하지 않는다.
- Probe RED: stable fresh/outdated resource, interrupted, source conflict, ambiguous, missing/deleted를 safe response로 구분하고 internal field/path를 노출하지 않는다.
- API RED: guard, exact content type, unknown field, raw-byte cap, UTF-8 cap, safe typed errors, durable/best-effort/pending success를 검증한다.
- Fence RED: valid/ambiguous tombstone은 params body getter 또는 filesystem보다 먼저 GET/PATCH 세 route를 각각 410/409로 막는다.
- Inventory RED: 디스크 route와 DATA_SURFACE_INVENTORY가 정확히 일치한다.

## 문서 최신화

- 이 phase에서는 정본 문서를 수정하지 않는다. 새 public schema와 recovery invariant에 필요한 source comment만 실제 behavior와 맞춘다.
- 최종 제품·아키텍처·ADR 문서는 phase 7이 갱신한다.

## 완료 게이트

```bash
npm test -- src/domain/__tests__/library.test.ts src/domain/__tests__/summarySchema.test.ts src/lib/__tests__/artifactPair.test.ts src/lib/__tests__/meetingLifecycle.test.ts src/lib/__tests__/publicApi.test.ts src/lib/__tests__/summarizePublisher.test.ts src/lib/__tests__/manualMeetingContent.test.ts
npm test -- src/app/api/__tests__/routes.integration.test.ts src/app/api/__tests__/tombstoneFence.test.ts src/lib/__tests__/localRequestGuard.test.ts
npm run typecheck
```
