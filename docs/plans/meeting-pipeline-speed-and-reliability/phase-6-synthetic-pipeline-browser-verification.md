# Phase 6 — Synthetic pipeline 브라우저 최종 검증

## 읽어야 할 파일

Fresh session은 root browser QA 계약, Playwright config/doctor/harness/reporter, synthetic support, ADR 0020·0024, committed installation spec와 pipeline settings/detail UI를 읽는다. 이 phase는 제품을 고치지 않는 verify-only phase다.

## 요구사항

- R1: Failure가 자동으로 사라지지 않고 manual retry control이 남는지 검증한다.
- R2: Quality-first Whisper model/save/prepare UX를 검증한다.
- R5: Full default와 fast explicit opt-in을 검증한다.
- R7: 세 viewport·synthetic-only evidence gate를 통과한다.

## 허용 범위

제품·test·문서 파일 수정은 허용하지 않는다. Committed repository-owned Playwright command만 실행하고 local evidence만 검사한다.

## 금지 및 중단 조건

- Doctor가 pinned Playwright package와 matching Chromium을 확인하지 못하면 중단한다.
- Snapshot에 workspace `data`, glossary, `.env`, Git metadata 또는 runtime benchmark output을 넣지 않는다.
- 실제 Whisper/model download/Ollama/Claude/Codex/external network를 호출하지 않는다.
- Desktop 또는 두 mobile viewport를 생략하지 않는다.
- 검증 전후 product tree가 달라지면 중단한다.

## 작업

1. `npm run test:e2e:doctor`의 read-only preflight 결과를 확인한다.
2. `npm run test:e2e`를 한 번 실행한다.
3. 다음 committed scenario assertion을 확인한다.
   - Missing setting에서 `large-v3`와 full이 default다.
   - Whisper select에 두 approved option만 있다.
   - Save request 뒤 prepare request 수는 0이다.
   - Explicit prepare는 준비 중/성공/안전한 실패를 synthetic route로 표시하고 stale response가 최신 state를 덮지 않는다.
   - Fast mode는 명시적 opt-in·실험 표기이며 저장 전에는 적용되지 않는다.
   - Summary failure는 자동 processing으로 되돌아가지 않고 재시도 button을 유지하며 click할 때만 one request가 발생한다.
4. `desktop-1440`, `mobile-390`, `mobile-320` evidence의 screenshot/assertion/console manifest를 확인한다.
5. External request, console/page error, horizontal overflow, 44px 미만 control, focus loss가 없는지 확인한다.
6. Git status가 실행 전후 동일한지 확인한다.

## 테스트 (먼저 작성)

이 phase는 새 test를 작성하지 않는다. Phase 1과 4가 작성해 commit한 synthetic scenario를 그대로 실행한다. 실제 data/provider를 넣어 test를 “보강”하지 않는다.

## 문서 최신화

문서 수정은 없다. Browser evidence는 `test-results/` 또는 execute local journal에만 남고 `docs/media`나 Git에 복사하지 않는다.

## 완료 게이트

저장소 루트에서 실행한다.

```bash
npm run test:e2e
```
