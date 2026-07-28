# Phase 7 — 전체 테스트 계약 회귀 보정

## 읽어야 할 파일

Fresh session은 로컬 요청 경계와 summarize pair publication ADR, 중앙 data-surface inventory, 새 pipeline/prepare route, generated summary schema, checkpoint 통합 경로와 전체 테스트에서 실패한 세 test 파일을 읽는다. Phase 1~6의 제품 동작을 다시 설계하지 않고 광역 gate가 드러낸 누락과 오래된 기대값만 보정한다.

## 요구사항

- R2: 새 pipeline settings와 model prepare data route를 중앙 로컬 요청 경계 inventory에 등록한다.
- R3: 실패한 summary의 수동 재시도가 durable correction checkpoint를 재사용한다는 호출 수 계약을 유지한다.
- R4: Generated summary가 generic JSON hint가 아니라 strict JSON Schema option을 사용한다는 integration 기대값을 맞춘다.
- R7: 전체 test inventory가 현재 route와 production summarize parser ownership을 정확히 검증하도록 한다.

## 허용 범위

`src/lib/localRequestGuard.ts`의 중앙 inventory와 그 직접 test, route integration test, command/API-only producer inventory test만 수정한다. Summarize production 구현, generated schema, 새 route 구현과 publisher는 수정하지 않는다.

## 금지 및 중단 조건

- 새 route의 공통 guard 순서를 늦추거나 기존 inventory equality 검사를 약화하지 않는다.
- Structured summary를 generic JSON으로 되돌리거나 checkpoint 재사용 대신 correction을 다시 실행하지 않는다.
- 더 쉬운 기대값을 위해 summarize publisher/parser ownership을 넓히지 않는다.
- 허용된 네 파일 밖 변경이 필요하면 중단한다.

## 작업

1. `DATA_SURFACE_INVENTORY`에 `/api/settings/pipeline`과 `/api/whisper/models/prepare`를 추가하고 기존 disk inventory equality·guard-first 검사를 그대로 통과시킨다.
2. Route integration test의 generated summary option 기대값을 static JSON Schema 계약으로 갱신한다.
3. Summary 실패 mock이 correction 호출과 schema summary 호출을 정확히 구분하게 해 첫 attempt는 correction 1회+summary 1회, manual retry는 checkpoint를 재사용한 summary 1회임을 검증한다.
4. Command producer inventory가 더 이상 호출되지 않는 combined `summarizeCore` 이름을 찾지 않고, 현재 app summarize path만 transcript resolution과 summary parsing production helper를 호출하는지 확인하게 한다.
5. Targeted regression과 typecheck를 통과한 뒤 runner의 전체 final gate로 넘긴다.

## 테스트 (먼저 작성)

현재 `npm test`가 route inventory 1건, producer inventory 1건, route integration 2건으로 RED다. 새 fixture나 실제 data/provider를 추가하지 않고 기존 synthetic/fake test를 현재 승인된 계약에 맞춰 GREEN으로 만든다.

## 문서 최신화

제품 문서는 Phase 5에서 이미 갱신됐다. 이 phase는 final-gate test 계약 보정만 수행하며 제품 문서를 다시 수정하지 않는다.

## 완료 게이트

저장소 루트에서 실행한다.

```bash
npm test -- scripts/__tests__/meeting-summarize.test.mjs src/lib/__tests__/localRequestGuard.test.ts src/app/api/__tests__/routes.integration.test.ts
npm run typecheck
```
