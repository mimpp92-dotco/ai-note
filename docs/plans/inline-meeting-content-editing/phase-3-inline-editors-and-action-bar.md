# Phase 3 — inline editors and action bar

두 탭의 로컬 action을 tablist 직후로 옮기고 읽기 본문과 editor를 mutually exclusive하게 렌더한다. Summary editor는 structure-aware form을 제거하고 transcript와 같은 한 개의 multiline body textarea가 된다.

## 읽어야 할 파일

상위 UI·접근성 지침, pure summary body helper, shared Tabs와 CopyButton의 소유권, MeetingDetailView의 confirmed/draft/save state machine, content editor form, layout navigation blocker와 RTL·Playwright scenario를 읽는다.

## 요구사항

- R1의 tablist 직후 action hierarchy를 구현한다.
- R2의 transcript read-body replacement editor를 구현한다.
- R3의 single freeform summary textarea와 section-title deletion을 구현한다.
- R5의 save/probe, freshness, discard/navigation, focus와 mutual exclusion을 유지한다.
- R6의 committed synthetic browser scenario assertion을 새 UX로 갱신한다.

## 허용 범위

Meeting detail view와 content editor, 두 component test, manual editing Playwright scenario만 수정한다. Shared tab primitive, navigation provider, server/API와 fixture generator는 건드리지 않는다.

## 금지 및 중단 조건

- 읽기 본문 아래 또는 옆에 두 번째 editor surface를 추가하지 않는다.
- Summary의 field/item form이나 hidden heading parser를 남기지 않는다.
- Tabs나 RecorderSessionProvider를 수정하지 않는다.
- contenteditable, HTML/Markdown renderer 또는 dependency를 추가하지 않는다.
- draft 보호·저장 판정·focus return을 단순화해 입력 손실을 허용하지 않는다.
- 실제 사용자 data를 테스트에 사용하지 않는다.

## 작업

1. Script와 summary tabpanel의 첫 region을 해당 탭 action group과 polite status로 만든다. Summary outdated warning과 content는 그 뒤에 온다.
2. Action 순서, accessible group name, Copy/JSON link, regeneration trigger와 44px responsive control grammar를 보존한다.
3. Editor mode가 transcript면 `ScriptTab` 대신 `TranscriptEditor`만 content region에 렌더한다. Read body DOM이 남아 있지 않아야 한다.
4. Editor mode가 summary면 `SummaryTab` 대신 body-only `SummaryEditor`를 렌더한다. Structured generated summary는 helper projection으로, manual summary는 exact body로 시작한다.
5. SummaryEditor는 visible label·helper, 하나의 resizable multiline textarea, 저장/취소, validation/status/supplemental recovery만 소유한다. Per-section input/add/delete/action row는 제거한다.
6. Body change 비교, draft copy, PATCH intended matching과 probe matching을 string 기준으로 바꾼다.
7. Copy와 download는 editor가 열려 있어도 confirmed current summary를 사용한다.
8. Dirty cancel과 다른 editor 전환은 기존 inline discard confirmation을 거친다. Confirmed discard 뒤 original body를 다시 렌더하고 continue는 same textarea/focus를 유지한다.
9. Save success는 editor를 닫고 confirmed body를 즉시 렌더하며 summary freshness를 해제한다. Error/conflict/ambiguous는 textarea와 exact draft를 유지한다.
10. E2E scenario는 action group이 content보다 앞서는 DOM order, read/edit mutual exclusion, summary heading text 삭제와 exact save, cancel original restoration을 세 viewport 공통 flow로 검증하도록 갱신한다.
11. Existing stale warning, generation dialog, detail back/sidebar/browser-back guard와 horizontal overflow assertion을 약화하지 않는다.

## 테스트 (먼저 작성)

- DOM order RED: 각 active tab action group이 stale warning/read body/editor보다 앞서고 global action은 변하지 않는다.
- Transcript replacement RED: 수정 click 뒤 confirmed text view는 0개, textarea는 1개이며 cancel/discard 뒤 원문 view가 정확히 복원된다.
- Summary replacement RED: field별 textbox와 add/delete는 0개, `회의록 요약 본문` textarea는 1개다.
- Projection RED: generated summary의 모든 visible section text가 결정적 순서로 textarea에 있고 meeting title/participants/topicSlug는 없다.
- Freeform RED: 섹션 제목을 삭제한 multiline body가 exact PATCH intended가 되고 success view/copy/freshness에 즉시 반영된다.
- Cancel RED: dirty body 취소 확인에서 계속 수정은 draft+focus를 유지하고 discard는 confirmed body를 복원한다.
- Probe/conflict RED: network, invalid 2xx, third revision, unavailable probe가 string body로 기존 state machine을 유지한다.
- Navigation RED: route/sidebar/browser back guard가 single textarea draft를 보존하며 saving/verifying에는 discard가 없다.
- Accessibility RED: visible labels, status relation, 44px controls, focus return, IME protection과 320px overflow를 검증한다.
- Playwright spec은 synthetic-only로 새 flow를 선언하되 실제 browser 실행은 Phase 5가 소유한다.

## 문서 최신화

이 phase에서는 문서를 수정하지 않는다. UI copy·accessible label은 구현 안에서 일치시키고 최종 계약 문서는 Phase 4가 갱신한다.

## 완료 게이트

```bash
npm test -- src/components/__tests__/MeetingContentEditors.test.tsx src/components/__tests__/views.test.tsx
npm run typecheck
```
