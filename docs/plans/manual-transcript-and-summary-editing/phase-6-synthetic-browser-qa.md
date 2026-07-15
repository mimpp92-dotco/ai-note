# Phase 6 — synthetic-browser-qa

앞선 TDD 구현을 실제 browser에서 검증한다. 현재 workspace의 `data/`를 절대 읽지 않고 repository 밖 temporary snapshot을 별도 cwd로 실행해 app의 `process.cwd()/data`가 synthetic fixture만 가리키게 한다. 제품 파일은 수정하지 않고 synthetic browser evidence만 전용 경로에 기록한다.

## 읽어야 할 파일

- `AGENTS.md`
- `package.json`
- `docs/UI_GUIDE.md`
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
- R8: stale, edit, error, confirmation, navigation guard, focus UX를 browser에서 검증한다.
- R9: synthetic-only desktop/mobile evidence를 남긴다.

## 허용 범위

- `docs/qa-evidence/manual-transcript-and-summary-editing/**`

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
- browser backend를 사용할 수 없으면 중단한다.
- 실제 Whisper, LLM, 외부 network 호출이 필요하면 중단한다.
- browser 검증을 위해 전용 synthetic evidence 경로 밖 repository 파일을 수정해야 하면 중단한다.
- desktop-1440, mobile-390, mobile-320 중 하나라도 검증할 수 없으면 중단한다.

## 작업

1. phase 시작과 종료에 `git status --short`를 기록하고 제품 파일 diff가 0이며 허용된 synthetic evidence 경로만 추가됐는지 scope evidence로 남긴다.
2. repository 밖 `mktemp` directory에 현재 phase commit의 source snapshot을 만든다. 원본 workspace의 `data/`, `.env*`, `glossary.json`은 copy, symlink, read 대상에서 제외한다. dependency cache/node_modules 재사용은 code-only read로 제한하고 temp cwd 밖 data path를 만들지 않는다.
3. temp snapshot 아래에 synthetic library와 meeting을 만든다.
   - 고정 synthetic meeting/workspace ID와 명백한 가짜 제목·참석자·스크립트·요약을 사용한다.
   - stable transcript/summary pair, contentRevision generated/fresh, 긴 multiline transcript, multiline summary item, audio 없음 상태를 만든다.
   - 파일 shape는 current domain parser로 사전 검증하고 real user artifact를 복사하지 않는다.
4. `AI_NOTE_DISABLE_WORKER=1`로 temp cwd의 Next server만 explicit loopback/unique port에 실행한다. Whisper, summarize worker, 실제 provider를 시작하지 않는다. browser의 모든 network origin이 해당 loopback 하나인지 기록한다.
5. desktop-1440에서 상세 initial state를 검증한다.
   - top global group에는 회의 이동, 폴더 열기, Markdown download만 있다.
   - Script tab 하단에 transcript copy/edit/raw regeneration이 있다.
   - Summary tab 하단에 summary copy/JSON/edit/current-transcript summary regeneration이 있다.
   - 상단 legacy `다시 요약`이 없다.
6. Script editor에서 synthetic text를 수정하고 실제 local PATCH를 저장한다. 성공 뒤 transcript view/copy가 갱신되고 summary tab label/panel에 `요약 갱신 필요`가 표시되며 summary text는 보존되는지 확인한다.
7. stale 상태에서 global Markdown download에 freshness warning이 포함되고 summary copy도 warning을 포함하는지 확인한다. JSON button은 stale help와 연결되지만 downloaded JSON schema에 새 freshness field가 없는지 확인한다.
8. Summary editor를 열어 multiline item이 하나의 item textarea로 유지되는지 확인하고 직접 저장한다. 성공 뒤 stale 표시가 사라지고 transcript가 바뀌지 않는지 확인한다.
9. 두 generation button의 확인 dialog를 각각 연되 실제 LLM confirm은 실행하지 않는다.
   - transcript dialog는 current transcript replacement와 summary stale 가능성을 설명한다.
   - summary dialog는 current transcript input과 manual summary replacement를 설명한다.
   - 둘 다 Cancel initial focus, Escape/cancel trigger return을 지킨다.
10. dirty transcript draft에서 detail back link와 sidebar navigation을 시도한다. navigation이 막히고 `계속 편집` initial focus, `수정 내용 버리고 이동` 문구, cancel focus return을 확인한다. browser back도 같은 보호를 사용하는지 확인한다.
11. mobile-390과 mobile-320에서 긴 transcript, multiline summary, action footer, dialog, error/status text를 확인한다.
    - horizontal overflow가 없다.
    - button target이 최소 44px다.
    - footer action이 content와 겹치지 않고 DOM/시각 순서가 유지된다.
    - long Korean text와 byte counter가 action width를 밀어내지 않는다.
12. keyboard로 tab switching, editor field/action, dialog cancel, footer control을 탐색하고 visible focus와 label/status relation을 확인한다.
13. browser console error 0, unhandled rejection 0, unexpected external request 0을 확인한다. 예상된 synthetic 4xx를 만들었다면 assertion에 이유와 UI recovery를 기록하되 console error는 남기지 않는다.
14. required evidence를 `docs/qa-evidence/manual-transcript-and-summary-editing/`에 남긴다. screenshot에는 synthetic data만 포함하고 manifest에 SHA-256, viewport, backend, byte size를 기록한다.
    - desktop fresh/stale와 mobile-390/mobile-320 screenshots.
    - action hierarchy, stale transition, multiline preservation, dialog focus, navigation guard, overflow assertions.
    - console/network origin summary.
15. server를 종료하고 temp snapshot을 제거한다. workspace `data/`를 열지 않았고 git status 변화가 허용된 evidence 경로뿐임을 다시 증명한다.

## 테스트 (먼저 작성)

- 이 phase는 앞선 TDD 구현의 browser evidence phase라 runtime test 추가를 면제한다.
- synthetic fixture parser validation이 실패하면 browser를 열기 전에 중단한다.
- 실제 LLM/Whisper를 실행하지 않으므로 generation은 confirm dialog까지만 검증하고 call-count/runtime semantics는 phase 2 tests를 증거로 연결한다.
- save API는 temp synthetic pair에만 실행하고 원본 workspace path 접근이 network/console/process log에 없음을 확인한다.

## 문서 최신화

- 이 phase에서는 repository 문서를 수정하지 않는다.
- browser에서 확인한 최종 copy·layout·focus contract는 phase 7 문서 갱신의 근거가 된다.

## 완료 게이트

```bash
npm run build
```
