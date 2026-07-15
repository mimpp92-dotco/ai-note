# Phase 4 — detail-action-hierarchy-and-editors

회의 상세의 global action과 두 탭의 local action을 분리하고, transcript/summary editor·독립 generation·summary freshness·save probe UX를 연결한다. 이 phase는 page 안 draft를 보존하며 route navigation guard는 phase 5가 소유한다.

## 읽어야 할 파일

- `AGENTS.md`
- `src/CLAUDE.md`
- `docs/UI_GUIDE.md`
- `src/app/meetings/*/page.tsx`
- `src/components/MeetingDetailView.tsx`
- `src/components/MeetingRow.tsx`
- `src/components/MeetingList.tsx`
- `src/components/Tabs.tsx`
- `src/components/AppDialog.tsx`
- `src/components/CopyButton.tsx`
- `src/components/__tests__/views.test.tsx`
- `src/components/__tests__/MeetingRow.test.tsx`
- `src/components/__tests__/MeetingList.test.tsx`
- `src/app/api/meetings/*/content/route.ts`
- `src/app/api/meetings/*/transcript/route.ts`
- `src/app/api/meetings/*/summary/route.ts`
- `src/app/api/meetings/*/transcript/regenerate/route.ts`
- `src/app/api/meetings/*/summarize/route.ts`
- `src/lib/summaryMarkdown.ts`

## 요구사항

- R2: 전체 스크립트 editor와 안전한 save/cancel/probe UX를 제공한다.
- R3: 모든 user-facing summary field를 multiline-safe 구조화 form으로 편집한다.
- R4: transcript-only와 summary-only generation을 각 탭에서 실행한다.
- R6: summaryOutdated와 consumer warning을 사용자에게 명확히 표시한다.
- R7: global, transcript footer, summary footer의 버튼 위계를 지킨다.
- R8: typed error, destructive confirmation, focus, mutual exclusion, 접근성을 지킨다.

## 허용 범위

- `src/app/meetings/*/page.tsx`
- `src/components/MeetingDetailView.tsx`
- `src/components/MeetingContentEditors.tsx`
- `src/components/MeetingRow.tsx`
- `src/components/MeetingList.tsx`
- `src/components/__tests__/views.test.tsx`
- `src/components/__tests__/MeetingContentEditors.test.tsx`
- `src/components/__tests__/MeetingRow.test.tsx`
- `src/components/__tests__/MeetingList.test.tsx`

## 금지 및 중단 조건

- `data/**`
- `.env*`
- `glossary.json`
- `whisper/**`
- `src/components/Tabs.tsx`
- `src/components/AppDialog.tsx`
- `src/components/RecorderSessionProvider.tsx`
- `src/components/RecorderNavigation.tsx`
- `src/app/api/**`
- `src/lib/**`
- `src/domain/**`
- global top group에 transcript-only 또는 summary-only action을 남겨야 하면 중단한다.
- 전체 스크립트 또는 요약 전용 action을 해당 tab footer 밖에 배치해야 하면 중단한다.
- 문자열 배열을 newline split textarea로 직렬화해 multiline item을 손실해야 하면 중단한다.
- dirty draft를 parent refresh 또는 tab 전환으로 덮어써야 하면 중단한다.
- network 또는 invalid success body를 probe 없이 확정 실패로 표시해야 하면 중단한다.
- Tabs 또는 AppDialog shared primitive를 변경해야 하면 중단한다.
- 실제 사용자 data로 UI를 검증해야 하면 중단한다.
- 허용 범위 밖 파일 수정이 필요하면 중단한다.

## 작업

1. 상세 RSC가 stable artifact pair에서 current transcript, full summary, pair revision, transcript/summary source, summaryOutdated, pair state를 읽고 `MeetingDetailView`에 전달한다. public contentOperation은 durable attempt와 in-memory operation을 정확한 kind로 합친다.
2. pair가 missing/ambiguous/source conflict거나 summary parse가 실패하면 edit/generation control을 만들지 않는다. 기존 read-only fallback, 새로고침, 데이터 폴더 열기 같은 safe recovery만 보여 준다.
3. `MeetingDetailView`는 server props와 별도로 confirmed snapshot과 draft를 소유한다. dirty/saving/verifying editor는 incoming refresh로 덮지 않는다. save 전 old revision과 intended normalized content를 함께 보관하고, valid success 또는 probe 확정 뒤에는 `confirmedRevision`과 직전 `predecessorRevision`을 함께 보관한다. pristine 상태에서도 incoming props를 hash가 다르다는 이유만으로 newer라 가정하지 않는다. confirmed와 같으면 no-op, predecessor와 같으면 늦은 refresh로 보고 무시하며, 둘 다 아닌 third revision은 no-store content probe가 같은 canonical revision을 확인한 경우에만 외부 변경으로 수용한다. probe 불일치·실패 시 confirmed snapshot을 유지하고 conflict/확인 불가 상태를 표시한다.
4. 상단 `회의 작업` global group을 다음으로 제한한다.
   - 회의 이동.
   - 폴더 열기.
   - summary + current transcript combined Markdown 다운로드.
   - 기존 요약 복사, 전사 복사, JSON 다운로드, 상단 `다시 요약`은 이 group에서 제거한다.
5. Script tab의 content 뒤에 `전체 스크립트 작업` footer를 둔다.
   - `전체 스크립트 복사`.
   - `전체 스크립트 수정`.
   - `원문에서 스크립트 다시 만들기`.
   - raw fallback에는 수정·재생성 control을 노출하지 않는다.
6. Summary tab의 content 뒤에 `회의록 요약 작업` footer를 둔다.
   - `요약 복사`.
   - `JSON 다운로드`.
   - `회의록 요약 수정`.
   - `현재 스크립트로 요약 다시 만들기`.
7. summaryOutdated이면 tab label과 summary panel에 `요약 갱신 필요`를 텍스트로 표시하고 “전체 스크립트가 변경되었지만 기존 요약은 유지됨”을 설명한다. `현재 스크립트로 요약 다시 만들기`와 `회의록 요약 수정`을 next action으로 제공한다.
8. stale summary copy는 phase 3 warning option을 사용하고 JSON download는 schema가 바뀌지 않음을 유지하면서 button help/status에 outdated를 연결한다. global Markdown link도 stale warning이 포함되는 server export를 사용한다.
9. `MeetingContentEditors.tsx`를 controlled form component로 추가한다. 파일 I/O, router, fetch, library state를 소유하지 않는다.
   - Transcript: current text로 시작하는 labeled textarea, UTF-8 byte counter/limit, save/cancel.
   - oneLine/purpose: labeled textarea.
   - highlights/discussion/decisions/risks/followups: item별 labeled textarea, add/delete, stable key, item 내부 개행 보존.
   - actionItems: owner/task/due 반복 행, add/delete.
   - title/topicSlug/participants input 없음.
10. 한 번에 한 editor만 연다. 다른 editor를 열거나 dirty editor를 닫을 때 inline 또는 AppDialog discard confirmation을 한 번 거친다. tab 전환은 editor mode, draft, validation, scroll-independent state를 parent에 보존한다.
11. save state machine을 `editing → saving → verifying? → saved|validation|conflict|error|ambiguous`로 고정한다.
    - valid 2xx resource를 strict check한 뒤 confirmed snapshot을 즉시 갱신하고 editor를 닫는다.
    - durability pending도 committed success이며 `저장됨 · 디스크 동기화 확인 대기`를 표시하고 PATCH를 재전송하지 않는다.
    - validation/413는 draft를 유지하고 first invalid field에 focus한다.
    - operation busy는 어떤 content 작업이 진행 중인지 표시하고 자동 mutation retry를 하지 않는다.
    - revision conflict는 draft를 유지하고 `내 입력 복사`, discard 확인이 있는 `최신 내용 불러오기`를 제공한다.
12. network error 또는 invalid 2xx body는 `저장 여부 확인 중`으로 전환하고 GET content probe를 한 번 실행한다.
    - intended normalized content + expected unchanged opposite artifact와 일치하면 saved로 확정한다.
    - old expected revision이면 not-saved로 확정하고 동일 draft 재시도를 허용한다.
    - third revision이면 conflict다.
    - ambiguous/source conflict/probe unavailable이면 mutation을 재전송하지 않고 editor/draft를 유지한 채 안전한 recovery를 안내한다.
13. transcript regeneration은 별도 AppDialog를 연다. current transcript가 대체되고 summary는 유지되지만 갱신 필요가 될 수 있음을 명시하며 Cancel이 initial focus다. confirm request는 exact confirmation flag와 current revision을 보낸다.
14. summary regeneration은 별도 AppDialog를 연다. current transcript가 입력이고 transcript는 바뀌지 않으며 현재 manual summary가 대체됨을 명시하며 Cancel이 initial focus다.
15. contentOperation별 polling과 local optimistic state를 분리한다.
    - initial: 기존 global 생성 상태.
    - transcript: script tab에 `스크립트 만드는 중…`, 완료 기준은 transcript operation 관측 후 해제다.
    - summary: summary tab에 `요약 만드는 중…`, 완료 기준은 summary operation 관측 후 해제다.
    - identical content도 operation 해제로 성공이다.
    - client timeout은 transcript 최대 1콜, summary 최대 2콜의 server timeout 합보다 짧지 않다.
16. 한 content mutation이 active면 다른 edit/generation mutation을 모두 disabled하고 이유를 텍스트로 제공한다. read-only copy/download는 “현재 저장된 내용”임을 분명히 한 채 유지할 수 있다. dialog는 busy 중 Escape/backdrop/cancel로 닫히지 않는다.
17. MeetingRow/MeetingList는 contentOperation에 따라 `전체 스크립트 생성 중` 또는 `회의록 요약 생성 중`을 표시한다. manual_edit를 요약 중으로 표시하지 않고 operation-specific retry action을 올바른 tab으로 연결한다.
18. 모든 footer/dialog/form control은 기존 warm palette, rectangular radius, 최소 44px target, visible focus를 사용한다. label-error-status relation, polite live text, success/cancel focus handoff, Korean IME composition 중 accidental submit 방지를 제공한다.

## 테스트 (먼저 작성)

- Hierarchy RED: top global group에는 이동/폴더/Markdown만 있고 transcript copy/edit/regenerate는 script footer, summary copy/JSON/edit/regenerate는 summary footer에만 있다.
- Visibility RED: stable pair에 local actions가 있고 raw fallback, missing, ambiguous, source conflict에서는 mutation action이 없다.
- Transcript edit RED: current text → PATCH expected revision → valid success가 manual transcript, outdated banner, copy source, confirmed snapshot을 즉시 갱신한다.
- Summary edit RED: 모든 editable field와 multiline item/add/delete/action row를 lossless 직렬화하고 success가 fresh summary view/copy를 즉시 갱신한다.
- No internal fields RED: title/topicSlug/participants input이나 PATCH field가 없다.
- Save verification RED: network와 invalid 2xx는 실패 문구/PATCH retry 대신 verifying + GET probe를 실행하고 intended/old/third/ambiguous를 각각 saved/not-saved/conflict/blocked로 판정한다.
- Snapshot ordering RED: local save 뒤 늦게 온 predecessor props는 confirmed content를 되돌리지 않고, third revision props는 content probe가 동일한 canonical revision을 확인할 때만 pristine snapshot에 반영한다. dirty/saving/verifying draft는 어떤 incoming props에도 유지된다.
- Validation RED: byte limit, empty transcript, invalid summary item/action이 draft를 유지하고 first invalid field에 focus한다.
- Conflict RED: content revision conflict에서 draft/editor/focus가 유지되고 copy draft와 confirm-before-latest action이 제공된다.
- Pending RED: pending을 committed warning으로 표시하고 editor를 닫으며 같은 PATCH를 자동 재전송하지 않는다.
- Freshness RED: transcript change는 summary tab label/panel/Markdown/summary copy warning을 켜고 summary edit/regeneration success는 끈다.
- Transcript generation RED: exact endpoint/body/confirmation, local label, correction-only completion, summary unchanged/outdated를 반영한다.
- Summary generation RED: current transcript endpoint/body/confirmation, local label, transcript unchanged/fresh summary를 반영한다.
- Destructive focus RED: 두 regeneration dialog 모두 Cancel initial focus, Escape/cancel trigger focus return, busy dismiss 차단을 지킨다.
- Mutual exclusion RED: editor, saving, verifying, transcript generation, summary generation 상태에서 반대 mutation이 실행되지 않고 reason이 표시된다.
- Polling RED: cold entry와 local start에서 kind별 operation 관측/해제, identical content success, kind별 failure, operation별 timeout을 정확히 판정한다.
- List RED: row/list가 transcript와 summary generation label을 구분하고 manual_edit를 생성 중으로 표시하지 않는다.
- Accessibility RED: footer group label, visible labels, role=status, 44px target, focus preservation, Korean IME composition safety를 검증한다.
- Regression GREEN: Tabs keyboard/ARIA, review freshness, meeting move, initial summarize status, title/participants, export route link가 유지된다.

## 문서 최신화

- 이 phase에서는 정본 문서를 수정하지 않는다. UI copy와 component comment만 실제 behavior와 맞춘다.
- UI_GUIDE와 사용자 문서는 phase 7에서 최종 구현과 browser evidence를 기준으로 갱신한다.

## 완료 게이트

```bash
npm test -- src/components/__tests__/MeetingContentEditors.test.tsx src/components/__tests__/views.test.tsx src/components/__tests__/MeetingRow.test.tsx src/components/__tests__/MeetingList.test.tsx
npm run typecheck
npm run lint
npm run build
```
