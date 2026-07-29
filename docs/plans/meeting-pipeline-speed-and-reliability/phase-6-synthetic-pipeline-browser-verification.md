# Phase 6 — Synthetic pipeline 브라우저 최종 검증

## 읽어야 할 파일

Fresh session은 root browser QA 계약, Playwright config/doctor/harness/reporter, synthetic support, ADR 0020·0024, committed installation spec와 pipeline settings/detail UI를 읽는다. 이전 verify-only 실행에서 accessible-name 부분 일치 때문에 Whisper select와 준비 상태가 동시에 선택된 strict locator 회귀를 test spec 안에서만 고친 뒤 전체 browser gate를 다시 실행한다.

## 요구사항

- R1: Failure가 자동으로 사라지지 않고 manual retry control이 남는지 검증한다.
- R2: Quality-first Whisper model/save/prepare UX를 검증한다.
- R5: Full default와 fast explicit opt-in을 검증한다.
- R7: 세 viewport·synthetic-only evidence gate를 통과한다.

## 허용 범위

`e2e/installation-and-first-run.spec.ts`의 ambiguous locator만 exact accessible-name locator로 좁힐 수 있다. 제품 컴포넌트·runtime·다른 test·문서는 수정하지 않고 repository-owned Playwright command와 local evidence로 결과를 검사한다.

## 금지 및 중단 조건

- Doctor가 pinned Playwright package와 matching Chromium을 확인하지 못하면 중단한다.
- Snapshot에 workspace `data`, glossary, `.env`, Git metadata 또는 runtime benchmark output을 넣지 않는다.
- 실제 Whisper/model download/Ollama/Claude/Codex/external network를 호출하지 않는다.
- Desktop 또는 두 mobile viewport를 생략하지 않는다.
- Locator 회귀 수정에 제품 컴포넌트나 다른 test 변경이 필요하면 중단한다.

## 작업

1. 실패한 Whisper model locator가 `"Whisper 모델"` select와 `"Whisper 모델 준비 상태"` status를 함께 고르는 회귀를 exact accessible-name locator로 먼저 고정한다.
2. `npm run test:e2e:doctor`의 read-only preflight 결과를 확인한다.
3. `npm run test:e2e -- e2e/installation-and-first-run.spec.ts`로 locator 회귀를 targeted 검증한 뒤 `npm run test:e2e` 전체 gate를 실행한다.
4. 다음 committed scenario assertion을 확인한다.
   - Missing setting에서 `large-v3`와 full이 default다.
   - Whisper select에 두 approved option만 있다.
   - Save request 뒤 prepare request 수는 0이다.
   - Explicit prepare는 준비 중/성공/안전한 실패를 synthetic route로 표시하고 stale response가 최신 state를 덮지 않는다.
   - Fast mode는 명시적 opt-in·실험 표기이며 저장 전에는 적용되지 않는다.
   - Summary failure는 자동 processing으로 되돌아가지 않고 재시도 button을 유지하며 click할 때만 one request가 발생한다.
5. `desktop-1440`, `mobile-390`, `mobile-320` evidence의 screenshot/assertion/console manifest를 확인한다.
6. External request, console/page error, horizontal overflow, 44px 미만 control, focus loss가 없는지 확인한다.
7. 허용된 E2E spec 외 제품 tree가 달라지지 않았는지 확인한다.

## 테스트 (먼저 작성)

Phase 1과 4가 작성해 commit한 synthetic scenario 자체가 회귀 test다. 실패한 부분 일치 locator를 exact match로 좁혀 같은 test를 통과시키며 새 fixture나 실제 data/provider를 넣어 “보강”하지 않는다.

## 문서 최신화

문서 수정은 없다. Browser evidence는 `test-results/` 또는 execute local journal에만 남고 `docs/media`나 Git에 복사하지 않는다.

## 완료 게이트

저장소 루트에서 실행한다.

```bash
npm run test:e2e -- e2e/installation-and-first-run.spec.ts
npm run test:e2e
```
