# Phase 7 — Final-gate transcription race repair

## 목표

전체 `npm test`가 재현한 transcription retry의 409 race 회귀를 기존 API와 polling 계약 안에서 수리한다. 제품 변경 뒤 세 viewport synthetic Playwright evidence를 다시 생성해 Phase 6 이후의 최종 상태도 검증한다.

## 읽어야 할 파일

- `AGENTS.md`
- `src/CLAUDE.md`
- transcription dispatch와 synthetic browser 관련 ADR
- E2E harness, first-run spec와 evidence reporter
- `src/components/MeetingDetailView.tsx`
- `src/components/__tests__/views.test.tsx`

## 요구사항

- `R5`
- `R7`

## 허용 범위

- `src/components/MeetingDetailView.tsx`

## 금지 및 중단 조건

- 기존 409 race test나 browser assertion을 약화하지 않는다.
- 새 endpoint, dispatch ID, status schema 또는 artifact writer를 만들지 않는다.
- 실제 data, Whisper, provider, credential 또는 외부 network를 사용하지 않는다.
- 허용 경로 밖 수정이 필요하면 중단한다.

## 작업

1. 현재 RED 테스트를 그대로 실행해 409 `meeting_conflict` 뒤 즉시 server state refresh가 누락된 상태를 확인한다.
2. 기존 `/api/transcribe` 요청, safe status copy, single-inflight polling과 cleanup을 유지하면서 접수 성공 또는 이미 진행 중 race 뒤 `router.refresh()`를 호출한다.
3. polling deadline, unmount/status-change cleanup, timeout copy와 focus 복원을 바꾸지 않는다.
4. 수정 후 targeted test, typecheck와 전체 synthetic Playwright를 실행한다.

## 테스트 (먼저 작성)

새 테스트를 만들거나 기존 assertion을 바꾸지 않는다. 이미 RED인 race 테스트를 회귀 계약으로 사용하며 제품 코드 수정으로 GREEN을 만든다.

## 문서 최신화

Phase 5 문서는 이미 “접수 성공 또는 이미 진행 중 race 뒤 최신 server state 확인”을 정본화했다. 이 phase에서는 문서를 다시 수정하지 않는다.

## 완료 게이트

```bash
npm test -- src/components/__tests__/views.test.tsx -t "이미 진행 중인 race도 refresh하고 전사 poll은 한 번에 하나만 두며 상태 변경에서 정리한다"
npm run typecheck
npm run test:e2e
```
