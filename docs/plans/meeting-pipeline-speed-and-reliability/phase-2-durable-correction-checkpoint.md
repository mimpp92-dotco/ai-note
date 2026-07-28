# Phase 2 — Durable 교정 체크포인트와 수동 재시도

## 읽어야 할 파일

Fresh session은 app summarize single-writer, tombstone, artifact lease, operation lock, status reconciliation과 manual editing ADR을 읽는다. 이어 `summarize.ts`, worker candidacy, publisher, glossary, atomic writer, current retry route/test를 읽는다. 정확한 목록은 `plan.json`을 따른다.

## 요구사항

- R1: 최초 실패 뒤 자동 retry를 제거하고 수동 retry만 새 attempt를 시작하게 한다.
- R3: 교정 성공 결과를 durable checkpoint로 보존해 요약 실패·중단 뒤 재사용한다.

## 허용 범위

새 checkpoint repository와 test, initial summarize orchestration, worker candidacy, 관련 route integration regression만 변경한다. Canonical publisher·pair repository·status schema를 새 checkpoint writer로 대체하지 않는다.

## 금지 및 중단 조건

- Checkpoint를 `data/meetings/{id}` 밖이나 public status/DTO/log에 저장하지 않는다.
- Source identity가 다른 checkpoint를 “비슷하다”는 이유로 재사용하지 않는다.
- Summary 실패 뒤 background poller가 자동으로 교정 또는 요약을 다시 실행하지 않는다.
- Canonical pair를 checkpoint module이 직접 쓰거나 publisher/lock/tombstone 경계를 약화하지 않는다.
- 사용자 artifact 삭제, 새 dependency 또는 허용 범위 밖 수정이 필요하면 중단한다.

## 작업

1. Hidden single-file correction checkpoint schema와 repository를 RED test로 정의한다.
   - Schema version, raw/glossary hashes, provider/model/provider-endpoint identity hash, prompt version, mode, chunk-plan hash, corrected transcript, completed chunk metadata, commit timestamp를 strict하게 읽는다.
   - Endpoint identity는 normalized local configuration의 hash만 저장하고 credential이나 arbitrary environment를 저장하지 않는다.
   - Symlink/non-regular/oversize/duplicate-field/corrupt/unknown-version은 invalid로 판정하고 자동 복구·덮어쓰지 않는다.
2. Checkpoint write는 temp → file fsync → rename → parent-directory fsync를 사용한다.
   - 결과 durability를 구분하고 pending을 성공으로 사용하지 않는다.
   - Existing valid checkpoint replace도 동일 contract를 쓴다.
3. Initial full correction flow를 분리한다.
   - Raw와 glossary snapshot, adapter identity, prompt version으로 key를 만든다.
   - Model correction이 기존 guard를 통과한 뒤 checkpoint를 commit한다.
   - Summary는 checkpoint의 resolved transcript만 받는다.
4. Manual retry에서 exact valid checkpoint를 먼저 찾는다.
   - Match면 correction call 수는 0, summary call부터 시작한다.
   - Mismatch면 checkpoint를 사용하지 않고 새 correction을 수행한다. Stale 파일 삭제 실패는 새 canonical publish를 막지 않되 stale content를 사용하지 않는다.
5. Failure/reconciliation policy를 바꾼다.
   - First automatic attempt가 실패하면 safe `retry_summary` 또는 interruption error를 유지한다.
   - Worker candidate는 모든 manual-attention summarize error를 제외한다. 과거 `MAX_SUMMARIZE_ATTEMPTS=3` 반복을 더 이상 자동 retry 근거로 쓰지 않는다.
   - Manual endpoint acceptance만 error를 지우고 새 attempt receipt를 durable commit한다.
6. Summary와 pair publication 성공 뒤 checkpoint를 best-effort cleanup한다.
   - Cleanup은 publication commit 이후이며 실패해도 committed pair를 rollback하거나 failure로 바꾸지 않는다.
   - Tombstoned/deleting meeting에서는 read/write/cleanup 모두 fail closed한다.

## 테스트 (먼저 작성)

- Checkpoint missing/valid/corrupt/symlink/oversize/unknown version과 atomic durability pending.
- Summary first failure → checkpoint retained → worker no candidate → manual retry → correction 0회/summary 1회.
- Provider/model/glossary/raw/prompt/mode mismatch → correction 재실행.
- Process interruption with live attempt → reconciliation error + checkpoint preserved + no automatic worker retry.
- Publication success → transcript-first/summary-last 유지 + cleanup; cleanup failure도 pair 성공 유지.
- Tombstone와 concurrent operation/attempt mismatch에서 no write/no reuse.

## 문서 최신화

정본 문서는 Phase 5에서 갱신한다. 코드 주석은 “attempt count가 자동 retry한다”는 오래된 설명처럼 이 phase가 직접 거짓으로 만드는 부분만 최소 수정한다.

## 완료 게이트

저장소 루트에서 실행한다.

```bash
npm test -- src/lib/__tests__/summarizeCheckpoint.test.ts src/lib/__tests__/summarize.test.ts src/lib/__tests__/summarizeWorker.test.ts src/app/api/__tests__/routes.integration.test.ts
npm run typecheck
```
