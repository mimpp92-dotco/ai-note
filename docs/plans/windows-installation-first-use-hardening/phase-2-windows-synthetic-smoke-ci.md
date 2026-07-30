# Phase 2 — Windows synthetic smoke CI

Windows hosted runner에서 dependency install·build와 existing first-use browser smoke를 최소 범위로 실행한다. Product browser scenario는 늘리지 않고 공백 경로와 OS 차이만 새 회귀 축으로 추가한다.

## 읽어야 할 파일

CI의 현재 Ubuntu gate, pinned Playwright package/config, E2E doctor·runner·snapshot server, existing smoke와 evidence reporter, ADR 0020의 synthetic-only 경계를 읽는다.

## 요구사항

- R5의 `windows-latest` 최소 job과 공백 포함 snapshot 경로를 구현한다.
- Existing `e2e/smoke.spec.ts`와 세 viewport evidence contract를 그대로 재사용한다.
- Windows 결과가 bootstrap full integration이 아니라 install/build + synthetic browser smoke임을 job 이름과 문서에서 정직하게 유지한다.

## 허용 범위

GitHub Actions workflow와 E2E temp snapshot prefix만 수정한다. Browser spec, fixture, reporter, product code, dependency와 lockfile은 수정하지 않는다.

## 금지 및 중단 조건

- 실제 `uv`, `ffmpeg`, Whisper model/service, Codex login, 사용자 data 또는 외부 network를 요구하지 않는다.
- Windows에서 전체 E2E suite를 실행하지 않는다.
- Playwright version·config·browser spec·evidence contract를 바꾸지 않는다.
- CI 편의를 위해 secret, persistent user artifact 또는 package dependency를 추가하지 않는다.

## 작업

1. `scripts/run-e2e.mjs`의 fresh OS temp snapshot 이름에 공백을 포함한다. Existing cleanup과 provenance는 그대로 유지한다.
2. `windows-latest` job에 Node 22, `npm ci`, setup/bootstrap/Codex 대상 테스트, `npm run build`를 추가한다.
3. Windows Chromium은 pinned package로 설치하고 `npm run test:e2e:doctor`를 통과시킨다.
4. Browser command는 `npm run test:e2e -- e2e/smoke.spec.ts`로 한정한다. Playwright config와 reporter가 desktop-1440, mobile-390, mobile-320을 모두 실행·검증하게 둔다.
5. Windows shell에서 명령 인용이나 경로 문제가 발생해도 package/runner redesign으로 범위를 넓히지 않고 증거와 함께 중단한다.

## 테스트 (먼저 작성)

새 product behavior를 추가하지 않으므로 existing harness/evidence unit contract를 실행한다. Phase 4의 repository Playwright가 공백 snapshot 경로에서 실제 smoke를 수행한다. Windows job 자체의 결과는 push 뒤 hosted runner에서 merge evidence로 확인한다.

## 문서 최신화

이 phase에서는 문서를 수정하지 않는다. CI가 보장하는 범위와 보장하지 않는 범위는 Phase 3에서 설명한다.

## 완료 게이트

```bash
npm test -- scripts/__tests__/e2e-harness.test.mjs scripts/__tests__/e2e-evidence-contract.test.ts
npm run lint -- scripts/run-e2e.mjs
npm run build
```
