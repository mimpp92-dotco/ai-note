# Phase 5 — synthetic browser verification

제품 파일을 수정하지 않고 committed manual-editing scenario를 pinned Chromium 세 viewport에서 실행한다. Action bar 위치와 본문 교체형 editor가 실제 browser layout·focus·navigation에서 동작하는지 repository evidence contract로 확인한다.

## 읽어야 할 파일

Synthetic browser 경계와 ADR 0020/0022, pinned Playwright 설정·doctor·temp snapshot runner, manual editing fixture/spec, evidence reporter, summary body helper와 detail/editor 구현을 읽는다.

## 요구사항

- R1의 tablist 직후 action 위치와 responsive hierarchy를 실제 DOM/layout에서 확인한다.
- R2·R3의 transcript/summary read-to-editor replacement, freeform heading deletion과 cancel restore를 확인한다.
- R5의 save/freshness/focus/navigation guard 회귀를 확인한다.
- R6의 synthetic-only screenshots/assertions/console manifest를 생성한다.

## 허용 범위

제품·테스트 파일 수정은 허용하지 않는다. 승인된 Playwright command 실행과 runner-owned evidence 생성만 수행한다.

## 금지 및 중단 조건

- 실제 workspace data, glossary, env secret, Git metadata를 snapshot에 넣지 않는다.
- 실제 Whisper, LLM, CLI provider 또는 외부 network를 호출하지 않는다.
- test failure를 이 verify-only phase에서 코드 수정으로 고치지 않는다.
- browser install/download를 자동 실행하지 않는다.
- 제품 tree에 tracked/untracked 변화가 생기면 성공 assertion과 무관하게 실패한다.

## 작업

1. Runner preflight가 `npm run test:e2e:doctor`로 exact Playwright package와 matching Chromium을 read-only 확인한다.
2. `npm run test:e2e`가 OS temp의 fresh source snapshot과 empty data root를 만들고 synthetic fixture만 설치한다.
3. Desktop 1440, mobile 390, mobile 320에서 다음을 확인한다.
   - global action group은 기존 세 전역 action만 가진다.
   - 각 tab action group은 tablist 직후, warning/read body/editor보다 먼저 온다.
   - 44px target과 flex wrap이 유지되고 horizontal scroll이 없다.
   - transcript edit는 read body를 제거하고 single textarea를 보인다.
   - summary edit는 field별 form 없이 single body textarea를 보인다.
   - section heading을 삭제한 body가 exact save되고 fresh summary view/copy에 반영된다.
   - dirty cancel의 continue는 draft/focus를 보존하고 confirmed discard는 원래 body를 복원한다.
   - stale warning, regeneration dialog, detail/sidebar/browser-back guard가 유지된다.
4. Automatic fixture/reporter가 required viewport screenshot, assertion pass, console/page error와 external request 0, synthetic provenance를 manifest에 기록한다.
5. Runner가 artifact hash·byte size·viewport·requirement coverage와 Git scope 불변을 검증한다.

## 테스트 (먼저 작성)

이 phase는 구현이나 test authoring을 하지 않는다. Phase 3에서 먼저 작성·커밋한 Playwright assertion을 그대로 실행한다. Assertion, console, network, artifact 또는 provenance 하나라도 실패하면 evidence를 보존하고 중단한다.

## 문서 최신화

문서는 Phase 4에서 갱신한다. Browser 실행 결과 때문에 문서를 수정하지 않으며 성공 evidence는 runner local journal/test-results에만 둔다.

## 완료 게이트

```bash
npm run test:e2e
```
