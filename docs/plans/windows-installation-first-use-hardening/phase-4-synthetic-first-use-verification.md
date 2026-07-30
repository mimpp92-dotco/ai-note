# Phase 4 — synthetic first-use verification

제품 파일을 수정하지 않고 repository-owned Playwright 전체 gate를 공백이 포함된 fresh snapshot에서 실행한다. 실제 browser가 AI NOTE 콘텐츠를 렌더하고 기존 synthetic 경계를 지키는지 확인한다.

## 읽어야 할 파일

ADR 0020/0023, pinned Playwright 설정·doctor·runner·snapshot server, Phase 2의 Windows workflow, existing smoke, synthetic fixture wrapper와 evidence reporter를 읽는다.

## 요구사항

- R1·R2의 runtime/readiness 변경 뒤에도 AI NOTE root와 library surface가 browser에서 렌더되는지 확인한다.
- R3·R5의 공백 snapshot 경로가 runner·build·browser server 경계를 깨지 않는지 확인한다.
- R6의 문서가 실행한 command와 일치하는지 최종 대조한다.
- Required screenshots, assertions, console manifest와 세 viewport를 repository evidence contract로 확인한다.

## 허용 범위

제품·테스트·문서 파일 수정은 허용하지 않는다. 승인된 Playwright command와 runner-owned `test-results` evidence 생성만 수행한다.

## 금지 및 중단 조건

- 실제 workspace data, glossary, env secret, Git metadata를 snapshot에 넣지 않는다.
- 실제 Whisper, LLM, CLI provider, mic 또는 외부 network를 호출하지 않는다.
- Test failure를 verify-only phase에서 코드 수정으로 고치지 않는다.
- Browser install/download를 자동 실행하지 않는다.
- 검증 전후 product tree가 바뀌면 assertion 성공과 무관하게 실패한다.

## 작업

1. Runner preflight가 `npm run test:e2e:doctor`로 exact Playwright package와 matching Chromium을 read-only 확인한다.
2. `npm run test:e2e`가 공백이 든 OS temp source snapshot과 empty data root를 만들고 synthetic fixture만 설치한다.
3. Desktop 1440, mobile 390, mobile 320에서 existing smoke를 포함한 전체 repository browser suite를 실행한다.
4. Smoke가 `/api/library` success, `AI NOTE` title, visible `main`, 제품 설명, workspace/meeting-list heading과 빈 상태 오탐 방지를 확인한다.
5. Reporter가 viewport별 screenshot/assertion, console/page error 0, external request 0과 synthetic provenance를 manifest에 남겼는지 검증한다.
6. Local browser success가 Windows hosted runner success를 대신하지 않음을 실행 journal에 남긴다.

## 테스트 (먼저 작성)

이 phase는 구현이나 test authoring을 하지 않는다. Phase 2에서 유지한 existing browser contract를 그대로 실행한다. Smoke, 다른 committed scenario, console, network, artifact, provenance 중 하나라도 실패하면 evidence를 보존하고 중단한다.

## 문서 최신화

문서는 Phase 3에서 갱신한다. Browser 결과 때문에 문서나 screenshot을 수정하지 않으며 evidence는 local journal 또는 `test-results`에만 둔다.

## 완료 게이트

```bash
npm run test:e2e
```
