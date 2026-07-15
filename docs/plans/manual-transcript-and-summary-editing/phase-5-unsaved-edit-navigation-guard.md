# Phase 5 — unsaved-edit-navigation-guard

기존 recorder navigation guard에 generic unsaved-content blocker 등록을 추가해 긴 transcript/summary draft가 sidebar, 목록, programmatic router, browser back/forward, reload로 사라지지 않게 한다. 녹음 원본 보호 동작은 그대로 유지하고 두 blocker가 동시에 존재하는 경우도 명시적으로 합성한다.

## 읽어야 할 파일

- `AGENTS.md`
- `docs/UI_GUIDE.md`
- `src/components/RecorderSessionProvider.tsx`
- `src/components/RecorderNavigation.tsx`
- `src/components/MeetingDetailView.tsx`
- `src/components/MeetingContentEditors.tsx`
- `src/components/AppDialog.tsx`
- `src/components/__tests__/RecorderSessionProvider.test.tsx`
- `src/components/__tests__/MeetingContentEditors.test.tsx`
- `src/components/__tests__/views.test.tsx`

## 요구사항

- R8: dirty/saving/verifying content editor와 unsaved audio를 모든 navigation surface에서 안전하게 보호한다.

## 허용 범위

- `src/components/RecorderSessionProvider.tsx`
- `src/components/RecorderNavigation.tsx`
- `src/components/MeetingDetailView.tsx`
- `src/components/MeetingContentEditors.tsx`
- `src/components/__tests__/RecorderSessionProvider.test.tsx`
- `src/components/__tests__/MeetingContentEditors.test.tsx`
- `src/components/__tests__/views.test.tsx`

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

## 문서 최신화

- 이 phase에서는 정본 문서를 수정하지 않는다. Context API comment와 dialog copy만 실제 blocker semantics와 맞춘다.
- UI_GUIDE의 generic unsaved navigation contract는 phase 7에서 갱신한다.

## 완료 게이트

```bash
npm test -- src/components/__tests__/RecorderSessionProvider.test.tsx src/components/__tests__/MeetingContentEditors.test.tsx src/components/__tests__/views.test.tsx
npm run typecheck
npm run lint
```
