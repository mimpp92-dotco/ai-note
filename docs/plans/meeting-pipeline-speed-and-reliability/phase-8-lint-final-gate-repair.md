# Phase 8 — Lint final gate 보정

## 읽어야 할 파일

Fresh session은 root/src 지침과 final gate가 unused-variable 오류를 보고한 component test, chat orchestrator test, correction runner test, summarize implementation의 정확한 주변 문맥만 읽는다.

## 요구사항

- R2: Pipeline settings component test의 fetch mock 계약을 유지한 채 unused 인자를 제거한다.
- R4: Chat structured-output test의 adapter option 계약을 바꾸지 않고 unused 인자를 제거한다.
- R5: Correction runner concurrency/failure test의 callback 의미를 바꾸지 않고 unused target 인자를 제거한다.
- R7: Summarize runtime의 사용되지 않는 local만 제거해 full lint gate를 통과시킨다.

## 허용 범위

Lint가 정확히 지목한 네 파일에서 unused callback parameter 또는 local variable만 제거한다. Assertion, production branch, error handling, public type와 lint 설정은 수정하지 않는다.

## 금지 및 중단 조건

- ESLint rule, ignore, TypeScript 설정을 완화하지 않는다.
- Test assertion이나 callback 횟수를 줄이지 않는다.
- Summarize behavior를 리팩터링하거나 새 helper를 만들지 않는다.
- 허용된 네 파일 밖 변경이 필요하면 중단한다.

## 작업

1. `PipelineSettingsForm.test.tsx`의 사용하지 않는 fetch init 인자를 제거한다.
2. `chatOrchestrator.test.ts`의 사용하지 않는 adapter options 인자를 제거한다.
3. `correctionRunner.test.ts`의 사용하지 않는 target callback 인자 두 곳을 제거한다.
4. `summarize.ts`의 사용하지 않는 meeting paths local을 제거한다.
5. 네 파일 targeted ESLint, 관련 targeted tests와 typecheck를 실행한다.

## 테스트 (먼저 작성)

새 동작을 추가하지 않는 lint-only repair다. 기존 tests를 수정된 callback 계약 그대로 실행하고 assertion을 약화하지 않는다.

## 문서 최신화

제품 문서 변경은 없다.

## 완료 게이트

저장소 루트에서 실행한다.

```bash
npx eslint src/components/__tests__/PipelineSettingsForm.test.tsx src/lib/__tests__/chatOrchestrator.test.ts src/lib/__tests__/correctionRunner.test.ts src/lib/summarize.ts
npm test -- src/components/__tests__/PipelineSettingsForm.test.tsx src/lib/__tests__/chatOrchestrator.test.ts src/lib/__tests__/correctionRunner.test.ts
npm run typecheck
```
