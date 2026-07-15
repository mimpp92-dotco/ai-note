# Phase 2 — independent-transcript-and-summary-generation

최초 생성, 전체 스크립트 재생성, 회의록 요약 재생성을 서로 다른 durable content operation으로 분리한다. 기존 상단 `다시 요약`이 수행하던 raw correction + summary 결합 동작은 최초 생성에만 남긴다.

## 읽어야 할 파일

- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/decisions/0009-async-resummarize-failure-visibility.md`
- `docs/decisions/0013-durable-summarize-pair-publication.md`
- `src/domain/meeting.ts`
- `src/domain/library.ts`
- `src/lib/summarize.ts`
- `src/lib/summarizeCore.ts`
- `src/lib/summarizePrompts.ts`
- `src/lib/summarizePublisher.ts`
- `src/lib/artifactPair.ts`
- `src/lib/manualMeetingContent.ts`
- `src/lib/summarizeWorker.ts`
- `src/app/api/meetings/*/summarize/route.ts`
- `src/app/api/summarize/route.ts`
- `src/lib/localRequestGuard.ts`
- `src/lib/__tests__/summarize.test.ts`
- `src/lib/__tests__/summarizeCore.test.ts`
- `src/lib/__tests__/summarizeWorker.test.ts`
- `src/lib/__tests__/localRequestGuard.test.ts`
- `src/app/api/__tests__/routes.integration.test.ts`
- `src/app/api/__tests__/tombstoneFence.test.ts`

## 요구사항

- R1: 최초 생성에서만 raw correction과 summary를 순차 실행한다.
- R4: transcript-only와 summary-only 재생성을 분리한다.
- R5: 두 async 작업도 durable attempt, expected revision, publisher recovery를 사용한다.
- R6: transcript-only는 summary를 outdated로, summary-only는 current transcript 기반 fresh로 기록한다.
- R8: 각 operation의 busy/failure/ambiguous를 정확한 종류로 노출한다.

## 허용 범위

- `src/lib/summarize.ts`
- `src/lib/summarizeCore.ts`
- `src/lib/summarizeWorker.ts`
- `src/lib/localRequestGuard.ts`
- `src/app/api/meetings/*/summarize/route.ts`
- `src/app/api/meetings/*/transcript/regenerate/route.ts`
- `src/app/api/summarize/route.ts`
- `src/lib/__tests__/summarize.test.ts`
- `src/lib/__tests__/summarizeCore.test.ts`
- `src/lib/__tests__/summarizeWorker.test.ts`
- `src/lib/__tests__/localRequestGuard.test.ts`
- `src/app/api/__tests__/routes.integration.test.ts`
- `src/app/api/__tests__/tombstoneFence.test.ts`

## 금지 및 중단 조건

- `data/**`
- `.env*`
- `glossary.json`
- `whisper/**`
- `src/services/llm/**`
- `src/lib/summarizePublisher.ts`
- `src/lib/knowledgeIndexRepository.ts`
- `src/lib/meetingSearch.ts`
- `src/lib/chatTools.ts`
- transcript regeneration이 summary adapter를 호출하거나 summary 내용을 새로 만들면 중단한다.
- summary regeneration이 correction adapter 또는 raw.md를 사용하면 중단한다.
- transcript 또는 summary의 변경하지 않는 반대쪽 artifact bytes를 바꿔야 하면 중단한다.
- legacy resummarize=true가 combined raw correction plus summary를 계속 실행해야 하면 중단한다.
- raw.md 또는 segments.json을 수정해야 하면 중단한다.
- 기존 LLM adapter, provider, API-key surface를 변경해야 하면 중단한다.
- 허용 범위 밖 파일 수정이 필요하면 중단한다.

## 작업

1. generation intent를 `initial | transcript_regenerate | summary_regenerate`로 명시하는 preparation contract를 만든다. 하나의 coordinator를 유지해도 되지만 intent별 input, LLM call, publisher payload, failure action이 분명해야 한다.
2. 최초 생성 경로를 보존한다.
   - summary가 없는 eligible meeting만 worker/CLI가 수락한다.
   - raw → correction prompt → resolved transcript → summary prompt → optional summary fallback 순서다.
   - initial attempt는 generated transcript와 generated summary를 같은 새 transcript hash에 묶는다.
3. `transcript_regenerate` 경로를 추가한다.
   - operation과 artifact read lease 안에서 stable current pair/content revision/expected revision을 확인한다.
   - immutable raw와 glossary로 correction adapter를 정확히 한 번 호출하고 `resolveTranscript`의 over-edit guard를 재사용한다.
   - summary prompt, summary adapter, summary fallback은 0회다.
   - publisher에는 새 transcript와 기존 summary bytes를 넘긴다. transcript source는 generated, summary metadata는 기존 값을 보존한다.
   - 새 transcript hash가 다르면 summaryOutdated가 되고 index refresh는 실행하지 않는다. 동일 hash면 기존 freshness를 유지한다.
4. `summary_regenerate` 경로를 추가한다.
   - operation과 artifact read lease 안에서 stable current pair/content revision/expected revision을 snapshot한다.
   - current canonical transcript를 summary prompt에 사용한다. raw read, correction prompt, correction adapter, over-edit guard는 0회다.
   - summary parse/normalization/fallback retry/40,000자 truncation notice는 기존 summary core 계약을 재사용한다.
   - publisher에는 기존 transcript bytes와 새 summary를 넘긴다. transcript revision은 보존하고 summary source generated, base=current transcript hash로 기록한다.
   - 성공 뒤에만 existing knowledge index refresh를 호출한다.
5. `summarizeCore.ts`에서 summary output parse/fallback 부분만 path/I/O 없는 함수로 최소 분리해 initial과 summary-only가 공유한다. correction resolve와 summary parse를 불필요한 범용 pipeline abstraction으로 합치지 않는다.
6. `POST /api/meetings/[id]/transcript/regenerate`를 추가한다.
   - guard → safe ID → tombstone fence → exact bounded JSON → accept 순서다.
   - body는 `{expectedRevision, confirmReplacement:true}`만 허용한다.
   - durable attempt가 committed/best-effort로 accepted된 뒤 202를 반환한다. pending acceptance는 work를 시작하지 않는다.
7. meeting-specific summarize route의 `{resummarize:true, expectedRevision}`를 summary-only로 바꾼다. summary가 있는 UI 재생성에는 expected revision이 필수다. initial 호환 요청은 기존 조건에서만 허용한다.
8. global `POST /api/summarize`의 `resummarize:true`는 CLI compatibility를 위해 acceptance 시점 current pair를 snapshot한 summary-only regeneration으로 해석한다. stale client가 없는 server-selected operation이므로 UI expected token을 가장하지 않는다.
9. `summarizeWorker`는 initial candidate만 자동 선택한다. outdated summary, transcript regeneration failure, summary regeneration failure를 background worker가 임의로 다시 실행하지 않는다.
10. operation-specific 실패를 보존한다.
    - transcript failure: old transcript/summary/content revision 유지, `retry_transcript_generation`, transcript tab action으로 복구.
    - summary failure: old summary와 기존 freshness 유지, `retry_summary`, summary tab action으로 복구.
    - ambiguous: 어떤 작업도 raw fallback이나 opposite operation으로 낮추지 않는다.
11. 동일 내용 generation도 durable attempt kind가 관측된 뒤 해제되면 성공이다. in-memory lock만이 아니라 status attempt kind를 cold-entry signal로 쓴다.
12. transcript regeneration은 correction 1콜 예산, summary regeneration은 summary+fallback 최대 2콜 예산을 갖는다. phase 4 client timeout은 실제 operation별 worst-case budget보다 짧게 잡지 않는다.
13. 새 transcript route를 `DATA_SURFACE_INVENTORY`에 등록하고 tombstone fence가 body getter보다 먼저임을 유지한다.

## 테스트 (먼저 작성)

- Initial RED: summary가 없는 회의는 correction 1회 + summary 1회(+필요 시 fallback 1회), generated/fresh content revision, full pair publication을 만든다.
- Transcript generation RED: raw correction 1회, summary adapter 0회, old summary bytes 보존, new generated transcript, changed hash에서 outdated를 만든다.
- Transcript identical RED: 동일 transcript 결과도 attempt 해제로 완료되고 summary freshness와 index를 불필요하게 바꾸지 않는다.
- Summary generation RED: raw read/correction call 0회, current transcript summary call만 수행하고 transcript bytes/source를 보존하며 fresh generated summary를 만든다.
- Manual source RED: 직접 수정한 transcript를 summary generation 입력으로 그대로 사용하며 correction call은 0회다.
- Legacy force RED: meeting-specific/global resummarize=true가 current transcript summary-only로 동작하고 raw correction을 호출하지 않는다.
- Preservation RED: 모든 경로가 titleOverride, review participants, internal summary participants, placement를 덮어쓰지 않는다.
- Failure RED: transcript failure는 old pair/revision + retry_transcript_generation, summary failure는 old pair/freshness + retry_summary를 유지한다.
- Conflict RED: expected revision stale, operation busy, source mismatch, ambiguous는 adapter/publisher/index 0회다.
- Acceptance durability RED: pending status acceptance는 adapter 0회이고 durable/best-effort만 202다.
- API RED: transcript exact confirmation, expected revision, unknown field/type/body cap, summarize initial/summary-only compatibility, safe typed errors를 검증한다.
- Fence RED: transcript regenerate tombstone fence는 body/LLM/fs보다 먼저 410/409를 반환한다.
- Worker RED: initial candidate만 자동 실행하고 summarized/outdated/error meeting을 임의 재생성하지 않는다.
- Regression GREEN: initial summary fallback, timeout classification, publisher crash reconciliation, title preservation, index failure non-rollback이 유지된다.

## 문서 최신화

- 이 phase에서는 정본 문서를 수정하지 않는다. intent별 call count와 compatibility를 설명하는 source comment만 실제 코드와 맞춘다.
- 제품 문구와 ADR은 phase 7에서 갱신한다.

## 완료 게이트

```bash
npm test -- src/lib/__tests__/summarizeCore.test.ts src/lib/__tests__/summarize.test.ts src/lib/__tests__/summarizeWorker.test.ts
npm test -- src/app/api/__tests__/routes.integration.test.ts src/app/api/__tests__/tombstoneFence.test.ts src/lib/__tests__/localRequestGuard.test.ts
npm run typecheck
```
