# Phase 6 — Final synthetic browser verification

## 목표

최종 committed product source를 수정하지 않고 repository-owned pinned Chromium으로 다시 실행해 install 이후 first-use와 transcription recovery UX가 세 viewport에서 재현되는지 증명한다.

## 읽어야 할 파일

- `AGENTS.md`
- `package.json`
- `playwright.config.ts`
- `docs/decisions/0020-deterministic-synthetic-browser-verification.md`
- `docs/decisions/0023-installation-and-first-run-ux.md`
- `scripts/e2e-doctor.mjs`
- `scripts/e2e-harness.mjs`
- `scripts/e2e-server.mjs`
- `scripts/run-e2e.mjs`
- `scripts/e2e-first-run-fixture.mjs`
- `e2e/global-setup.mjs`
- `e2e/smoke.spec.ts`
- `e2e/manual-transcript-and-summary-editing.spec.ts`
- `e2e/installation-and-first-run.spec.ts`
- `e2e/support/synthetic-test.ts`
- `e2e/support/evidence-reporter.ts`
- 변경된 home/settings/recorder/meeting component

## 요구사항

- `R2`
- `R3`
- `R4`
- `R5`
- `R6`
- `R7`

## 허용 범위

- `(none: verify-only)`

## 금지 및 중단 조건

- 모든 product, test, fixture, document와 plan 파일 수정이 금지된다.
- doctor가 pinned package와 Chromium revision 정합을 확인하지 못하면 중단한다.
- 실제 data, glossary, `.env*`, credentials, Whisper, Ollama, CLI provider 또는 external network가 필요하면 중단한다.
- desktop 1440, mobile 390, mobile 320 중 하나라도 실행할 수 없으면 중단한다.
- first-use, selector, auto health, default summary, transcription retry, focus, target size 또는 overflow assertion이 실패하면 중단한다.
- console/page error, external request 또는 required evidence가 누락되면 중단한다.
- 검증 전후 product tree가 달라지면 중단한다.

## 작업

1. `npm run test:e2e:doctor` preflight로 Node, exact Playwright package와 matching Chromium을 확인한다.
2. `npm run test:e2e`가 새 temp snapshot과 synthetic fixture만 설치하는지 확인한다.
3. desktop-1440, mobile-390, mobile-320에서 smoke, existing manual editing과 installation/first-run scenario를 모두 실행한다.
4. first-use card, recorder focus, provider selector/custom 보존, auto health copy, settings order, default summary, persistent transcription failure와 exact retry request assertion을 확인한다.
5. reporter manifest의 synthetic provenance, viewport, screenshot/assertion/console artifact hash와 external request 0을 확인한다.
6. 실행 전후 `git status`와 product fingerprint가 같아야 한다.

## 테스트 (먼저 작성)

이 phase는 test authoring이나 구현을 하지 않는다. Phase 4에서 먼저 작성하고 통과한 repository-owned scenario를 그대로 실행한다. 실패 evidence는 보존하되 이 phase에서 code를 고치지 않고 owning phase repair로 돌린다.

## 문서 최신화

문서는 Phase 5에서 완료됐다. Browser 결과 때문에 정본 문서나 `docs/media`를 수정하지 않는다.

## 완료 게이트

```bash
npm run test:e2e
```
