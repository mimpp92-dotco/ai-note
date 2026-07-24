# Phase 4 — Synthetic first-run browser scenarios

## 목표

설치 이후 사용자가 실제로 보는 first-use, model selector와 transcription recovery를 isolated synthetic browser에서 검증한다. 실제 로컬 service나 사용자 data를 사용하지 않고 변경된 home/settings 문서 이미지만 같은 synthetic state로 갱신한다.

## 읽어야 할 파일

- `AGENTS.md`
- `package.json`
- `playwright.config.ts`
- `docs/decisions/0020-deterministic-synthetic-browser-verification.md`
- `scripts/e2e-doctor.mjs`
- `scripts/e2e-harness.mjs`
- `scripts/e2e-server.mjs`
- `scripts/run-e2e.mjs`
- `scripts/e2e-manual-editing-fixture.mjs`
- 기존 E2E fixture/harness test
- `e2e/global-setup.mjs`
- `e2e/smoke.spec.ts`
- `e2e/manual-transcript-and-summary-editing.spec.ts`
- `e2e/support/synthetic-test.ts`
- `e2e/support/evidence-reporter.ts`
- Phase 2와 3의 변경된 settings/home/recorder/meeting component와 route
- Browser가 발견한 server/client 경계 또는 programmatic focus 회귀는 `plan.json`의 좁은 `allowedPaths`에 지정한 meeting page, `Recorder`, `MeetingDetailView`에서만 수리한다.
- 기존 `docs/media/home.png`, `docs/media/settings.png`는 required text context가 아니라 visual inspection 대상으로만 비교한다.

## 요구사항

- `R2`
- `R3`
- `R4`
- `R5`
- `R6`
- `R7`

## 허용 범위

- `e2e/global-setup.mjs`
- `e2e/smoke.spec.ts`
- `e2e/manual-transcript-and-summary-editing.spec.ts`
- `e2e/installation-and-first-run.spec.ts`
- `scripts/e2e-first-run-fixture.mjs`
- `scripts/__tests__/e2e-first-run-fixture.test.mjs`
- `docs/media/home.png`
- `docs/media/settings.png`

## 금지 및 중단 조건

- 실제 `data/`, glossary, `.env*`, credentials, user home, Git metadata를 snapshot에 포함하지 않는다.
- 실제 Whisper, Ollama, Claude/Codex CLI, OS browser opener 또는 외부 network를 호출하지 않는다.
- fixture는 runner-owned absolute snapshot root와 exact sentinel 없이는 쓰거나 reset하지 않는다.
- evidence manifest, console log와 assertion report를 `docs/media`에 복사하지 않는다.
- viewport, focus, target size, overflow, request 또는 evidence assertion을 약화해 통과시키지 않는다.
- 허용 경로 밖 수정이 필요하면 중단한다.

## 작업

1. 새 fixture unit test를 먼저 작성한다.
   - absolute runner-owned root와 real directory 요구
   - unknown content/symlink 거부
   - desktop/mobile project별 distinct transcription-failure meeting
   - manual editing fixture sentinel과 exact coexistence
   - idempotence와 실제 repository `data/` 비접촉
2. `scripts/e2e-first-run-fixture.mjs`를 추가하고 global setup에서 기존 manual fixture 다음에 설치한다.
3. 기존 smoke count와 manual editing detail 진입은 새 fixture와 summary-default 계약을 명시적으로 반영한다. 기존 편집 assertion 자체는 약화하지 않는다.
4. `e2e/installation-and-first-run.spec.ts`는 settings save/health, Ollama tags와 transcribe POST를 browser route interception으로 응답해 server-owned settings/status 파일을 test 중 직접 reset하거나 쓰지 않는다.
5. browser scenario는 다음을 검증한다.
   - unconfigured readiness card와 녹음 비차단
   - `요약 없이 회의 녹음`의 recorder scroll/focus
   - 44px target, wrap와 document horizontal overflow 없음
   - settings에서 model-first/profile-second 순서
   - Claude options, Codex default/custom, Ollama installed/custom/refresh
   - unknown saved model exact preservation과 provider별 draft 격리
   - save 후 health auto request, CLI `감지됨`과 Ollama `연결됨`의 정직한 label
   - successful first meeting CTA
   - completed meeting default summary와 explicit script override
   - list/detail의 persistent `전사 실패`
   - retry click의 exact `POST /api/transcribe`와 loading/focus/safe result
6. Ollama tags, CLI health와 transcribe 결과는 browser route interception과 sentinel-backed fixture state로만 제공한다. 실제 local daemon/process를 탐색하지 않고 product app-api의 single-writer 소유권도 우회하지 않는다.
7. home/settings의 changed state를 각 문서 이미지와 같은 viewport에서 capture하고 Playwright assertion을 통과한 synthetic PNG만 `docs/media/home.png`, `docs/media/settings.png`에 반영한다.
8. reporter가 모든 required viewport의 screenshot, assertion, console, external-request 0과 manifest hash를 기록하는지 확인한다.

## 테스트 (먼저 작성)

- Fixture filesystem contract를 unit RED/GREEN으로 먼저 구현한다.
- Browser spec은 requirement annotation과 web-first assertion을 사용한다.
- Screenshot 설명만으로 pass하지 않고 focus, DOM order, request body, status label, target geometry와 overflow를 직접 assert한다.
- Browser binary는 doctor가 확인한 pinned Playwright revision만 사용한다.

## 문서 최신화

이 phase는 바뀐 home/settings의 synthetic product image만 갱신한다. 설치 문구, 정본 계약과 ADR은 Phase 5에서 코드와 browser 결과에 맞춰 작성한다.

## 완료 게이트

```bash
npm test -- scripts/__tests__/e2e-first-run-fixture.test.mjs scripts/__tests__/e2e-harness.test.mjs scripts/__tests__/e2e-evidence-contract.test.ts
npm run test:e2e
```
