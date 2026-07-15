# Phase 5 — unsaved-edit-navigation-guard

기존 recorder navigation guard에 generic unsaved-content blocker 등록을 추가해 긴 transcript/summary draft가 sidebar, 목록, programmatic router, browser back/forward, reload로 사라지지 않게 한다. 녹음 원본 보호 동작은 그대로 유지하고 두 blocker가 동시에 존재하는 경우도 명시적으로 합성한다. 구현이 끝난 같은 checkpoint에서 runner-owned snapshot용 synthetic fixture와 Playwright 시나리오를 커밋해 다음 verify-only phase가 모델이나 Chrome session 없이 검증만 수행할 수 있게 한다.

## 읽어야 할 파일

- `AGENTS.md`
- `docs/UI_GUIDE.md`
- `docs/decisions/0020-deterministic-synthetic-browser-verification.md`
- `package.json`
- `playwright.config.ts`
- `scripts/e2e-harness.mjs`
- `e2e/smoke.spec.ts`
- `e2e/support/evidence-reporter.ts`
- `e2e/support/synthetic-test.ts`
- `src/domain/library.ts`
- `src/domain/meeting.ts`
- `src/domain/summarySchema.ts`
- `src/lib/__tests__/library.test.ts`
- `src/components/RecorderSessionProvider.tsx`
- `src/components/RecorderNavigation.tsx`
- `src/components/MeetingDetailView.tsx`
- `src/components/MeetingContentEditors.tsx`
- `src/components/AppDialog.tsx`
- `src/components/__tests__/RecorderSessionProvider.test.tsx`
- `src/components/__tests__/MeetingContentEditors.test.tsx`
- `src/components/__tests__/views.test.tsx`

## 요구사항

- R7: global/tab-local 작업 위계를 deterministic Playwright 시나리오로 고정한다.
- R8: dirty/saving/verifying content editor와 unsaved audio를 모든 navigation surface에서 안전하게 보호한다.
- R9: 실제 사용자 data를 읽지 않는 synthetic fixture·assertion·evidence 계약을 구현한다.

## 허용 범위

- `src/components/RecorderSessionProvider.tsx`
- `src/components/RecorderNavigation.tsx`
- `src/components/MeetingDetailView.tsx`
- `src/components/MeetingContentEditors.tsx`
- `src/components/__tests__/RecorderSessionProvider.test.tsx`
- `src/components/__tests__/MeetingContentEditors.test.tsx`
- `src/components/__tests__/views.test.tsx`
- `playwright.config.ts`
- `scripts/e2e-manual-editing-fixture.mjs`
- `scripts/__tests__/e2e-manual-editing-fixture.test.mjs`
- `scripts/__tests__/e2e-evidence-contract.test.ts`
- `e2e/global-setup.mjs`
- `e2e/manual-transcript-and-summary-editing.spec.ts`
- `e2e/smoke.spec.ts`
- `e2e/support/evidence-contract.ts`
- `e2e/support/evidence-reporter.ts`

## 금지 및 중단 조건

- `data/**`
- `.env*`
- `glossary.json`
- `whisper/**`
- `src/components/AppDialog.tsx`
- `src/components/LibraryNavigation.tsx`
- `src/app/**`
- `src/lib/**`
- `src/domain/**`
- saving 또는 verifying 중인 content mutation을 discard하고 이동해야 하면 중단한다.
- unsaved audio와 content draft 중 하나를 조용히 버려야 하면 중단한다.
- sidebar link, programmatic router, popstate, beforeunload 중 하나를 보호할 수 없으면 중단한다.
- AppDialog 또는 LibraryNavigation shared primitive 수정이 필요하면 중단한다.
- synthetic browser fixture가 runner-owned snapshot 밖을 읽거나 써야 하면 중단한다.
- browser contract 작성에 실제 사용자 data, 기존 dev server, Whisper, LLM 또는 외부 network가 필요하면 중단한다.
- 허용 범위 밖 파일 수정이 필요하면 중단한다.

## 작업

1. `RecorderSessionProvider`가 기존 recorder state 외에 bounded generic navigation blocker registry를 제공하게 한다. 이름은 기존 provider를 유지해 app layout refactor를 피하되 public context에는 register/unregister API만 최소 추가한다.
2. blocker descriptor는 stable ID와 다음 정보만 가진다.
   - kind `meeting_content_edit`.
   - phase `dirty | saving | verifying`.
   - 사람이 이해할 수 있는 label `전체 스크립트 수정` 또는 `회의록 요약 수정`.
   - discard 가능한 dirty 상태의 callback.
   - current/destination URL에 대한 allow rule. Content blocker는 page를 떠나는 변경을 막고, recorder의 기존 scope-only 예외를 자신에게 적용하지 않는다.
3. `MeetingDetailView`가 editor 상태에 맞춰 blocker를 등록·갱신·해제한다. render 중 등록하지 않고 effect cleanup으로 route unmount와 editor close에서 stale blocker를 남기지 않는다.
4. `GuardedLink`와 `useGuardedRouter`의 기존 호출자는 바꾸지 않고 `requestNavigation`이 active recorder/content blocker 모두를 평가하게 한다. 모든 active blocker가 허용할 때만 즉시 commit한다.
5. content-only dirty dialog를 제공한다.
   - title: `수정 내용이 저장되지 않았습니다`.
   - 설명: 어떤 editor draft가 남아 있는지와 이동하면 사라짐을 텍스트로 알린다.
   - initial focus/cancel: `계속 편집`.
   - destructive action: `수정 내용 버리고 이동`.
   - Escape/cancel은 connected trigger로 focus를 돌린다.
6. content saving/verifying 중 navigation을 시도하면 discard action을 제공하지 않고 `저장 결과를 확인한 뒤 이동합니다` 상태를 표시한다. 성공으로 blocker가 해제되면 사용자가 요청한 pending navigation을 commit하고, 실패로 dirty가 되면 discard confirmation으로 전환한다. ambiguous/verifying이 끝나지 않으면 이동하지 않는다.
7. unsaved audio와 content draft가 동시에 있으면 한 dialog에서 둘을 모두 열거한다. destructive action은 `녹음과 수정 내용 버리고 이동`처럼 두 손실을 이름으로 표시하고 두 discard callback이 모두 성공적으로 적용된 뒤에만 navigation을 commit한다.
8. recorder-only copy, stop-and-stay, permanent discard, scope-only navigation 의미는 기존과 동일하게 유지한다. Content blocker 추가 때문에 녹음 보호가 약해지거나 recorder timer/capture가 unmount되지 않는다.
9. `beforeunload`는 unsaved audio 또는 content blocker가 하나라도 있으면 best-effort browser warning을 건다. saving/verifying도 포함한다.
10. `popstate`는 blocker가 있으면 current URL을 복원하고 dialog를 연다. confirm 후 suppress-next-pop 규칙으로 정확히 한 번 destination으로 이동한다.
11. programmatic push/replace/back, sidebar `GuardedLink`, detail back link가 같은 pending navigation과 focus-return 계약을 사용한다. tab 전환은 route navigation이 아니므로 guard를 열지 않는다.
12. blocker 등록 순서나 React Strict Mode effect 재실행이 duplicate dialog, double discard, double navigation을 만들지 않게 idempotent registry update를 사용한다.
13. `scripts/e2e-manual-editing-fixture.mjs`에 test-only bootstrap을 구현한다.
   - `AI_NOTE_E2E_SNAPSHOT_ROOT`가 `scripts/e2e-harness.mjs`의 runner-owned absolute root 검사를 통과한 경우에만 그 아래 `data/`를 쓴다.
   - source repository, 실제 `data/`, `.env*`, `glossary.json`, HOME을 탐색하거나 symlink로 연결하지 않는다.
   - desktop-1440, mobile-390, mobile-320 전용 meeting ID를 각각 하나씩 만들고 명백한 가짜 한국어 제목·참석자·긴 transcript·multiline summary만 사용한다.
   - 세 meeting은 같은 valid synthetic library에 배치하되 각 viewport가 자기 meeting만 수정해 project 간 mutation이 섞이지 않게 한다.
   - app data API가 처음 호출되기 전 한 번만 bootstrap하고, 같은 fixture 재호출은 exact sentinel을 확인한 뒤 idempotent하게 종료한다. 알 수 없는 기존 내용이 있으면 덮어쓰지 않고 실패한다.
14. `e2e/global-setup.mjs`가 위 fixture를 모든 E2E 실행에 일관되게 설치하도록 `playwright.config.ts`에 연결한다. 기존 empty-library smoke는 synthetic library shell smoke로 바꿔 feature spec과 함께 실행해도 순서 의존 없이 통과하게 한다.
15. evidence contract를 확장한다.
   - `e2e/support/evidence-contract.ts`는 Playwright test annotation의 `requirement` 값을 정규화해 manifest `coveredRequirements`를 결정하고 annotation이 없는 smoke-only 실행은 기존 synthetic smoke ID로 하위 호환한다.
   - evidence reporter는 fixture ID를 `ai-note-synthetic-library-v1`로 기록하고 같은 viewport의 여러 success screenshot을 덮어쓰지 않고 모두 hash/size와 함께 보존한다.
   - console error, unhandled page error, unexpected external request, 누락 viewport 또는 누락 attachment는 계속 실패다.
16. `e2e/manual-transcript-and-summary-editing.spec.ts`에 R7/R8/R9 annotation을 붙이고 세 project에서 같은 semantic flow를 검증한다.
   - top global group과 두 tab footer의 exact action, legacy global regenerate 부재, 긴 content overflow와 44px target을 확인한다.
   - transcript local PATCH 저장 뒤 화면/copy가 바뀌고 summary 내용은 보존된 채 `요약 갱신 필요`가 나타나는지 확인한다.
   - summary multiline item을 항목 하나로 수정·저장한 뒤 transcript 불변과 fresh 복귀를 확인한다.
   - 두 regeneration dialog는 confirm하지 않고 copy, Cancel initial focus, Escape/trigger focus return만 확인해 실제 LLM을 호출하지 않는다.
   - dirty editor에서 detail back/sidebar/browser back을 막고 discard 전 draft 보존, cancel focus return, 명시적 discard 후 단 한 번 이동을 확인한다.
   - desktop fresh/stale와 mobile action/dialog/overflow milestone을 synthetic screenshot으로 첨부한다.
17. feature spec은 `e2e/support/synthetic-test.ts`의 자동 console/network/success evidence fixture를 사용한다. `npm run test:e2e` 전체 suite가 smoke와 feature spec을 함께 세 viewport에서 실행하도록 유지하며 test ordering에 의존하지 않는다.

## 테스트 (먼저 작성)

- Registration RED: transcript/summary dirty state가 blocker를 한 번 등록하고 pristine/save/cancel/unmount에서 해제한다. Strict Mode 재실행에도 중복이 없다.
- Link RED: detail back link와 sidebar GuardedLink가 dirty draft에서 navigation을 막고 `계속 편집`에 initial focus를 둔다.
- Programmatic RED: push/replace/back이 같은 dialog와 pending destination을 사용한다.
- Popstate RED: URL을 복원하고 confirm 후 한 번만 history destination으로 이동한다.
- Beforeunload RED: dirty/saving/verifying 각각 warning을 걸고 pristine에서 제거한다.
- Dirty discard RED: `수정 내용 버리고 이동` 전에는 draft/navigation이 유지되고 confirm 뒤 draft callback과 navigation이 각각 한 번 실행된다.
- Saving RED: saving/verifying에는 discard가 없고 성공 해제 뒤 pending navigation을 commit한다. failure→dirty는 discard dialog로 바뀌며 ambiguous는 이동하지 않는다.
- Combined RED: unsaved audio와 content draft를 모두 문구에 표시하고 둘을 함께 버리는 명시적 confirm 전에는 어느 것도 discard하지 않는다.
- Recorder regression GREEN: recorder-only scope navigation, stop-and-stay, discard, retained Blob, upload, beforeunload/popstate, focus return 테스트가 그대로 통과한다.
- Tab RED: dirty editor tab 전환은 navigation dialog를 열지 않고 draft를 유지한다.
- Focus RED: cancel/Escape는 original link/button trigger, confirmed navigation은 destination heading 정책을 유지한다.
- Fixture RED: unsafe/missing snapshot root, symlink, non-empty unknown data, viewport fixture 누락을 거부하고 valid empty snapshot에 세 synthetic meeting만 idempotent하게 만든다.
- Suite isolation RED: global setup 뒤 smoke와 manual feature spec의 실행 순서가 바뀌어도 각 viewport가 자기 meeting만 수정하고 결과가 같아야 한다.
- Evidence RED: R7/R8/R9 annotation을 manifest requirement로 수집하고 같은 viewport의 milestone screenshot을 모두 보존한다. invalid annotation과 누락 viewport/console/network attachment는 통과시키지 않는다.
- Browser scenario는 이 phase에서 source contract로 커밋한다. 실제 Chromium 실행·screenshot/hash/console evidence 검증은 바로 다음 model-free verify-only phase가 단독 소유한다.

## 문서 최신화

- 이 phase에서는 정본 문서를 수정하지 않는다. Context API comment와 dialog copy만 실제 blocker semantics와 맞춘다.
- UI_GUIDE의 generic unsaved navigation contract는 phase 7에서 갱신한다.

## 완료 게이트

```bash
npm test -- src/components/__tests__/RecorderSessionProvider.test.tsx src/components/__tests__/MeetingContentEditors.test.tsx src/components/__tests__/views.test.tsx
npm test -- scripts/__tests__/e2e-manual-editing-fixture.test.mjs scripts/__tests__/e2e-evidence-contract.test.ts
npm run typecheck
npm run lint
```
