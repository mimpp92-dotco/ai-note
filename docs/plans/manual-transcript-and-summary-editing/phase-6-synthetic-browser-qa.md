# Phase 6 — synthetic-browser-qa

앞선 phase가 커밋한 synthetic fixture와 Playwright 시나리오를 모델 없이 그대로 실행한다. `/execute` runner가 pinned browser preflight를 통과시킨 뒤 별도 attempt worktree에서 `npm run test:e2e`만 수행하며, 제품 파일은 하나도 수정하지 않는다. screenshot·assertion·console manifest는 명령이 runner-owned Git local journal에 직접 기록한다. Chrome DevTools MCP나 기존 Chrome session은 이 완료 gate에 관여하지 않는다.

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

- `(none: verify-only)`

## 금지 및 중단 조건

- `data/**`
- `.env*`
- `glossary.json`
- `src/**`
- `scripts/**`
- `whisper/**`
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
- browser 검증 명령이 product tree를 수정하거나 command-owned evidence 밖에 산출물을 써야 하면 중단한다.
- desktop-1440, mobile-390, mobile-320 중 하나라도 검증할 수 없으면 중단한다.

## 작업

1. `/execute` runner의 Playwright preflight가 `npm run test:e2e:doctor`를 read-only로 실행해 exact `@playwright/test`와 matching Chromium 준비 상태를 확인한다. 실패하면 dependency 설치나 다운로드를 자동 수행하지 않고 phase 시작 전에 중단한다.
2. runner가 phase baseline에서 별도 attempt worktree와 command-owned evidence directory를 만든다. phase 모델을 호출하거나 제품 코드·테스트·문서를 생성하지 않는다.
3. `npm run test:e2e`가 OS temp에 allowlist source snapshot을 만들고 pinned Chromium을 시작한다.
   - 원본 workspace의 `data/`, `.env*`, `glossary.json`, Git metadata는 copy·symlink·read 대상에서 제외한다.
   - global setup은 runner-owned snapshot 안에만 `ai-note-synthetic-library-v1` fixture를 설치한다.
   - background worker, 실제 Whisper/LLM/CLI/provider는 비활성화하고 app server는 explicit loopback에만 bind한다.
4. smoke와 manual editing spec을 desktop-1440, mobile-390, mobile-320 세 project에서 모두 실행한다.
   - top global group에는 회의 이동, 폴더 열기, combined Markdown download만 있고 legacy 상단 `다시 요약`은 없어야 한다.
   - Script footer에는 copy/edit/raw regeneration, Summary footer에는 copy/JSON/edit/current-transcript summary regeneration만 있어야 한다.
   - transcript 저장은 summary를 보존한 채 stale 표시를 만들고, multiline summary 저장은 transcript를 보존한 채 fresh 상태를 복원해야 한다.
   - 두 regeneration dialog는 실제 provider를 호출하지 않고 copy, Cancel initial focus, Escape/trigger focus return을 검증해야 한다.
   - dirty draft는 detail back, sidebar, browser back에서 보존되고 명시적 discard 전에는 이동하지 않아야 한다.
   - 긴 Korean transcript, multiline summary, status/error text, footer와 dialog에 horizontal overflow가 없어야 하고 interactive target은 44px 이상이어야 한다.
5. automatic evidence fixture와 reporter가 다음을 manifest에 기록한다.
   - R7, R8, R9 requirement coverage와 모든 Playwright assertion 성공.
   - 세 viewport 각각의 synthetic screenshot 및 milestone screenshot SHA-256·byte size.
   - browser console error 0, unhandled page error 0, unexpected external request 0.
   - `usedRealUserData=false`, `forbiddenRootAccessed=false`, `externalNetworkAccessed=false`.
6. runner가 manifest schema·artifact hash·viewport·synthetic provenance를 직접 검증한다. 명령 종료 뒤 app child와 temp snapshot이 정리되어야 한다.
7. phase 전후 product tree manifest와 Git scope를 비교한다. tracked/untracked 제품 경로 변화가 하나라도 있으면 browser assertion이 통과했더라도 phase를 실패시킨다.

## 테스트 (먼저 작성)

- 이 phase는 앞선 TDD phase가 작성·커밋한 테스트를 실행만 하는 model-free verify-only 단계이므로 새 테스트 작성을 면제한다.
- fixture, assertion, reporter 또는 제품 코드가 부족하면 이 phase에서 고치지 않는다. 실패 evidence를 보존하고 해당 구현 phase의 계약 수정이 필요한 상태로 중단한다.
- 실제 LLM/Whisper를 실행하지 않으므로 generation은 confirm 전 dialog까지만 검증한다. adapter call-count와 publisher semantics는 phase 2의 unit/API test evidence를 사용한다.
- screenshot의 문구는 모두 committed synthetic fixture여야 하며 실제 회의 제목·참석자·전사·요약을 가져오지 않는다.

## 문서 최신화

- 이 phase에서는 repository 문서를 수정하지 않는다.
- browser에서 검증된 최종 label, layout, focus 계약은 phase 7이 정본 문서에 반영한다.
- Chrome DevTools MCP를 사용한 정성 점검은 필요할 때 별도로 할 수 있지만 이 phase의 필수 evidence나 대체 backend가 아니다.

## 완료 게이트

```bash
npm run test:e2e
```
