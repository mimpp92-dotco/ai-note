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
- R7의 입력 한도, confirmed/draft 구분, 탭 문맥과 오류별 복구 행동을 구현한다.

## 허용 범위

Meeting detail view와 content editor, 두 component test, manual editing Playwright scenario만 수정한다. Shared tab primitive, navigation provider, server/API와 fixture generator는 건드리지 않는다.

## 금지 및 중단 조건

- 읽기 본문 아래 또는 옆에 두 번째 editor surface를 추가하지 않는다.
- Summary의 field/item form이나 hidden heading parser를 남기지 않는다.
- Tabs나 RecorderSessionProvider를 수정하지 않는다.
- contenteditable, HTML/Markdown renderer 또는 dependency를 추가하지 않는다.
- draft 보호·저장 판정·focus return을 단순화해 입력 손실을 허용하지 않는다.
- 화면의 draft와 copy/download가 사용하는 confirmed 저장본을 안내 없이 같은 내용처럼 보이게 하지 않는다.
- Whitespace/oversize, missing, operation, conflict, ambiguous와 unknown-commit 오류를 하나의 generic retry 상태로 합치지 않는다.
- 실제 사용자 data를 테스트에 사용하지 않는다.

## 작업

1. Script와 summary tabpanel의 첫 region을 해당 탭 action group과 polite status로 만든다. Summary outdated warning과 content는 그 뒤에 온다.
2. Action 순서, accessible group name, Copy/JSON link, regeneration trigger와 44px responsive control grammar를 보존한다. 열린 editor의 같은 수정 trigger는 `수정 중` state를 명시해 silent no-op이 되지 않는다.
3. Editor가 열리면 action status에 복사와 JSON/combined Markdown 다운로드가 textarea draft가 아니라 마지막 confirmed 저장본을 사용한다고 scope에 맞게 알린다.
4. Editor mode가 transcript면 `ScriptTab` 대신 `TranscriptEditor`만 content region에 렌더한다. Read body DOM이 남아 있지 않아야 한다.
5. Editor mode가 summary면 `SummaryTab` 대신 body-only `SummaryEditor`를 렌더한다. Structured generated summary는 Phase 1 helper projection으로, manual summary는 exact body로 시작한다.
6. SummaryEditor는 visible label·helper, 하나의 resizable multiline textarea, UTF-8 body byte 정보, 저장/취소, validation/status/supplemental recovery만 소유한다. Per-section input/add/delete/action row는 제거한다.
7. Whitespace-only body는 textarea에서 network 전에 거부한다. 저장 직전에는 exact `{expectedRevision,body}` JSON string의 UTF-8 byte length를 기존 512 KiB route cap과 비교해 초과 요청을 fetch 전에 막고, 두 경우 모두 draft와 textarea focus를 유지한다.
8. Body dirty 비교, draft copy, PATCH intended matching과 probe matching은 CRLF normalization 뒤 exact string 기준으로 바꾼다. Manual body를 trim, parse 또는 heading 기준으로 재구성하지 않는다.
9. Save refusal은 validation/413, `meeting_not_found`, `content_operation_in_progress`, revision conflict, source conflict/state ambiguous와 일반 unavailable을 구분한다. Network/invalid 2xx만 read-only probe로 intended/predecessor/third/unavailable을 판정하고 PATCH는 자동 재전송하지 않는다.
10. Missing/deleted는 더 이상 저장할 수 없음을, operation-in-progress는 기다린 뒤 같은 draft로 재시도할 수 있음을 알린다. Conflict는 exact draft copy와 confirm-before-latest, source/ambiguous는 copy와 fail-closed recovery만 제공한다. 모든 상태 문구는 실패 → draft/confirmed 보존 → 다음 행동 순서이며 textarea 또는 안전한 recovery control로 focus를 둔다.
11. 편집 tab을 잠시 벗어나도 owning tab label이 idle/error/conflict/missing=`수정 중`, saving=`저장 중`, verifying=`저장 확인 중`, ambiguous=`저장 확인 필요`를 표시하고 exact draft를 유지한다. Summary의 `요약 갱신 필요` token은 뒤에 보존한다. Save/cancel 결과가 다른 tab에서 완료돼도 editor 소유 tab과 trigger로 focus handoff가 유실되지 않는다.
12. Dirty cancel과 다른 editor 전환은 inline discard confirmation을 거친다. Confirmation은 `계속 수정`을 먼저 두고 그 control에 focus/announcement를 옮긴다. Confirmed discard 뒤 original body를 다시 렌더하고 continue는 same textarea/focus를 유지한다.
13. Save success는 editor를 닫고 confirmed body를 즉시 렌더하며 summary freshness를 해제한다. Pending durability는 committed warning이고 error/conflict/ambiguous/missing은 textarea와 exact draft를 유지한다.
14. E2E scenario는 stale predecessor annotation을 현재 R1/R2/R3/R5/R6/R7 coverage로 교체하고, action group이 content보다 앞서는 DOM order, read/edit mutual exclusion, summary heading text 삭제와 exact save, confirmed-copy 안내, discard 안전 초점, cancel original restoration을 세 viewport 공통 flow로 검증하도록 갱신한다.
15. Existing stale warning, generation dialog, detail back/sidebar/browser-back guard와 horizontal overflow assertion을 약화하지 않는다.

## 테스트 (먼저 작성)

- DOM order RED: 각 active tab action group이 stale warning/read body/editor보다 앞서고 global action은 변하지 않는다.
- Transcript replacement RED: 수정 click 뒤 confirmed text view는 0개, textarea는 1개이며 cancel/discard 뒤 원문 view가 정확히 복원된다.
- Summary replacement RED: field별 textbox와 add/delete는 0개, `회의록 요약 본문` textarea는 1개다.
- Projection RED: generated summary의 heading/bullet/action 표기, block LF와 no trailing LF가 Phase 1 helper와 같고 meeting title/participants/topicSlug는 없다.
- Validation RED: whitespace-only와 serialized PATCH 512 KiB 초과는 fetch 0건, exact draft 보존, byte/error relation과 textarea focus를 만든다.
- Freeform RED: 섹션 제목을 삭제한 multiline body가 exact PATCH intended가 되고 success view/copy/freshness에 즉시 반영된다.
- Confirmed action RED: editor가 열린 동안 copy/JSON/combined Markdown은 confirmed 저장본을 사용하고 그 사실을 action status가 설명하며 active edit trigger는 no-op state가 아니다.
- Cancel RED: dirty body 취소 확인은 `계속 수정`에 focus/announcement를 두고 draft를 유지하며 explicit discard만 confirmed body를 복원한다.
- Probe/refusal RED: network, invalid 2xx, predecessor/third/unavailable probe와 validation/413, missing, operation, source/ambiguous response가 string body로 구분되고 blind PATCH retry가 없다.
- Tab context RED: owning tab을 벗어났다 돌아와도 draft·save state를 유지하고 label이 그 상태를 알리며 completion focus handoff가 사라지지 않는다.
- Navigation RED: route/sidebar/browser back guard가 single textarea draft를 보존하며 saving/verifying에는 discard가 없다.
- Accessibility RED: visible labels, status relation, 44px controls, focus return, IME protection과 320px overflow를 검증한다.
- Playwright spec은 synthetic-only와 현재 requirement annotation으로 새 flow를 선언하되 실제 browser 실행은 Phase 5가 소유한다.

## 문서 최신화

이 phase에서는 문서를 수정하지 않는다. UI copy·accessible label은 구현 안에서 일치시키고 최종 계약 문서는 Phase 4가 갱신한다.

## 완료 게이트

```bash
npm test -- src/components/__tests__/MeetingContentEditors.test.tsx src/components/__tests__/views.test.tsx
npm run typecheck
```
