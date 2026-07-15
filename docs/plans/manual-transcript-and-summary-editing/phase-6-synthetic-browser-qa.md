# Phase 6 — synthetic-browser-qa

앞선 phase가 커밋한 synthetic fixture와 Playwright 시나리오를 실행한다. 최초 verify-only attempt에서 CommonJS 기본 package의 TypeScript Playwright spec이 ESM `.mjs` fixture를 정적으로 import해 loader가 실패했고, 첫 amended attempt가 격리 patch에서 runtime import로 복구한 뒤 두 Playwright spec의 exact `모든 회의` assertion이 현재 workspace-qualified H1과 불일치함을 드러냈다. 이 amended phase는 보존된 import patch와 두 spec의 H1 assertion만 TDD로 복구한다. fixture 값은 복제하지 않고 committed fixture를 runtime에 읽으며, 수정 뒤 전체 3-viewport suite와 screenshot·assertion·console manifest를 runner-owned Git local journal에서 검증한다. Chrome DevTools MCP나 기존 Chrome session은 이 완료 gate에 관여하지 않는다.

## 읽어야 할 파일

- `AGENTS.md`
- `package.json`
- `playwright.config.ts`
- `docs/UI_GUIDE.md`
- `docs/decisions/0020-deterministic-synthetic-browser-verification.md`
- `scripts/e2e-doctor.mjs`
- `scripts/e2e-harness.mjs`
- `scripts/e2e-server.mjs`
- `scripts/run-e2e.mjs`
- `scripts/e2e-manual-editing-fixture.mjs`
- `e2e/global-setup.mjs`
- `e2e/manual-transcript-and-summary-editing.spec.ts`
- `e2e/smoke.spec.ts`
- `e2e/support/evidence-contract.ts`
- `e2e/support/evidence-reporter.ts`
- `e2e/support/synthetic-test.ts`
- `src/domain/library.ts`
- `src/app/meetings/*/page.tsx`
- `src/components/MeetingDetailView.tsx`
- `src/components/MeetingContentEditors.tsx`
- `src/components/RecorderSessionProvider.tsx`
- `src/components/__tests__/views.test.tsx`
- `src/app/api/meetings/*/content/route.ts`
- `src/app/api/meetings/*/transcript/route.ts`
- `src/app/api/meetings/*/summary/route.ts`

## 요구사항

- R7: global과 두 tab footer의 실제 시각·동작 위계를 검증한다.
- R8: stale, edit, confirmation, navigation guard, focus UX를 browser에서 검증한다.
- R9: synthetic-only desktop/mobile evidence를 결정적으로 생성하고 검증한다.

## 허용 범위

- `e2e/manual-transcript-and-summary-editing.spec.ts`
- `e2e/smoke.spec.ts`

## 금지 및 중단 조건

- `data/**`
- `.env*`
- `glossary.json`
- `src/**`
- `scripts/**`
- `whisper/**`
- `playwright.config.ts`
- `e2e/global-setup.mjs`
- `e2e/support/**`
- `docs/decisions/**`
- `docs/plans/**`
- `docs/ARCHITECTURE.md`
- `docs/PRD.md`
- `docs/UI_GUIDE.md`
- `package.json`
- `package-lock.json`
- repository 밖 temporary snapshot과 synthetic data root를 격리할 수 없으면 중단한다.
- workspace의 실제 data, glossary, env secret 중 하나라도 읽어야 하면 중단한다.
- `npm run test:e2e:doctor`가 pinned Playwright 또는 matching Chromium을 확인하지 못하면 중단한다.
- 실제 Whisper, LLM, 외부 network 호출이 필요하면 중단한다.
- 허용된 Playwright spec 두 파일 밖 수정이나 fixture 값 복제가 필요하면 중단한다.
- browser 검증 명령이 product tree를 수정하거나 command-owned evidence 밖에 산출물을 써야 하면 중단한다.
- desktop-1440, mobile-390, mobile-320 중 하나라도 검증할 수 없으면 중단한다.

## 작업

1. `/execute` runner의 Playwright preflight가 `npm run test:e2e:doctor`를 read-only로 실행해 exact `@playwright/test`와 matching Chromium 준비 상태를 확인한다. 실패하면 dependency 설치나 다운로드를 자동 수행하지 않고 phase 시작 전에 중단한다.
2. `--strategy continue`가 첫 blocked attempt의 runtime import patch를 적용한 상태에서 `npm run test:e2e`를 실행해, 두 spec의 exact `모든 회의` assertion이 workspace-qualified H1과 불일치하는 현재 실패를 RED evidence로 재현한다. 보존 patch가 없으면 최초 static ESM import 실패부터 다시 재현한다.
3. 허용된 두 spec만 수정해 module-loading과 현재 accessible heading 계약을 함께 복구한다.
   - `e2e/manual-transcript-and-summary-editing.spec.ts`는 CommonJS로 transform되는 TypeScript spec에서 ESM `.mjs` fixture를 Node/Playwright가 지원하는 runtime 경계로 읽는다.
   - 두 spec의 library H1 assertion은 synthetic workspace 이름을 복제하지 않고 workspace-qualified 제목이 의미상 `모든 회의` view임을 검증한다.
   - H1 외 기존 API, hierarchy, focus, guard, overflow assertion을 약화하거나 삭제하지 않는다.
   - `MANUAL_EDITING_WORKSPACE_ID`와 `manualEditingMeetingForProject`의 정본은 계속 `scripts/e2e-manual-editing-fixture.mjs`다.
   - fixture 상수·project mapping을 spec에 복제하지 않는다.
   - `package.json`의 module type, Playwright config, global setup, fixture, reporter를 바꾸지 않는다.
4. `npm run test:e2e`가 OS temp에 allowlist source snapshot을 만들고 pinned Chromium을 시작한다.
   - 원본 workspace의 `data/`, `.env*`, `glossary.json`, Git metadata는 copy·symlink·read 대상에서 제외한다.
   - global setup은 runner-owned snapshot 안에만 `ai-note-synthetic-library-v1` fixture를 설치한다.
   - background worker, 실제 Whisper/LLM/CLI/provider는 비활성화하고 app server는 explicit loopback에만 bind한다.
5. smoke와 manual editing spec을 desktop-1440, mobile-390, mobile-320 세 project에서 모두 실행한다.
   - top global group에는 회의 이동, 폴더 열기, combined Markdown download만 있고 legacy 상단 `다시 요약`은 없어야 한다.
   - Script footer에는 copy/edit/raw regeneration, Summary footer에는 copy/JSON/edit/current-transcript summary regeneration만 있어야 한다.
   - transcript 저장은 summary를 보존한 채 stale 표시를 만들고, multiline summary 저장은 transcript를 보존한 채 fresh 상태를 복원해야 한다.
   - 두 regeneration dialog는 실제 provider를 호출하지 않고 copy, Cancel initial focus, Escape/trigger focus return을 검증해야 한다.
   - dirty draft는 detail back, sidebar, browser back에서 보존되고 명시적 discard 전에는 이동하지 않아야 한다.
   - 긴 Korean transcript, multiline summary, status/error text, footer와 dialog에 horizontal overflow가 없어야 하고 interactive target은 44px 이상이어야 한다.
6. automatic evidence fixture와 reporter가 다음을 manifest에 기록한다.
   - R7, R8, R9 requirement coverage와 모든 Playwright assertion 성공.
   - 세 viewport 각각의 synthetic screenshot 및 milestone screenshot SHA-256·byte size.
   - browser console error 0, unhandled page error 0, unexpected external request 0.
   - `usedRealUserData=false`, `forbiddenRootAccessed=false`, `externalNetworkAccessed=false`.
7. runner가 manifest schema·artifact hash·viewport·synthetic provenance를 직접 검증한다. 명령 종료 뒤 app child와 temp snapshot이 정리되어야 한다.
8. phase 전후 Git scope를 비교한다. 허용된 spec 두 파일 외 tracked/untracked 제품 경로 변화가 하나라도 있으면 browser assertion이 통과했더라도 phase를 실패시킨다. verify command 자체는 제품 파일을 수정하지 않아야 한다.

## 테스트 (먼저 작성)

- 최초 RED: baseline의 `npm run test:e2e`가 TypeScript spec의 static ESM fixture import에서 `Cannot use import statement outside a module`로 실패한다.
- 현재 RED: 보존된 runtime import patch 뒤 같은 명령이 두 spec의 stale exact `모든 회의` H1 assertion으로 실패한다.
- GREEN: spec이 committed `.mjs` fixture를 지원되는 runtime module boundary로 읽고 workspace-qualified H1을 의미에 맞게 검증하며 같은 명령이 세 viewport에서 통과해야 한다.
- fixture, assertion, reporter 또는 제품 코드의 다른 수정이 필요하면 이 phase에서 고치지 않는다. 실패 evidence를 보존하고 중단한다.
- 실제 LLM/Whisper를 실행하지 않으므로 generation은 confirm 전 dialog까지만 검증한다. adapter call-count와 publisher semantics는 phase 2의 unit/API test evidence를 사용한다.
- screenshot의 문구는 모두 committed synthetic fixture여야 하며 실제 회의 제목·참석자·전사·요약을 가져오지 않는다.

## 문서 최신화

- 이 phase에서는 repository 문서를 수정하지 않는다. 허용된 두 spec의 harness compatibility repair만 커밋한다.
- browser에서 검증된 최종 label, layout, focus 계약은 phase 7이 정본 문서에 반영한다.
- Chrome DevTools MCP를 사용한 정성 점검은 필요할 때 별도로 할 수 있지만 이 phase의 필수 evidence나 대체 backend가 아니다.

## 완료 게이트

```bash
npm run test:e2e
```
