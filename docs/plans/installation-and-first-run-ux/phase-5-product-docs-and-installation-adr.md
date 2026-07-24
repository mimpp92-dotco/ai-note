# Phase 5 — Product docs and installation ADR

## 목표

검증된 install command, 실제 URL, browser 경계, first-use, model selector와 transcription recovery를 사람과 에이전트가 같은 의미로 읽을 수 있게 공개 정본과 ADR에 반영한다.

## 읽어야 할 파일

- `AGENTS.md`
- `README.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md`
- `.claude/commands/setup.md`
- `scripts/CLAUDE.md`
- `src/CLAUDE.md`
- `docs/PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/UI_GUIDE.md`
- `docs/decisions/README.md`
- `docs/decisions/0012-local-ingress-and-fixed-id-service-boundary.md`
- `docs/decisions/0014-durable-transcription-dispatch.md`
- `docs/decisions/0016-atomic-finalize-directory-publication.md`
- `docs/decisions/0020-deterministic-synthetic-browser-verification.md`
- Phase 1 bootstrap, Phase 2 settings, Phase 3 retry, Phase 4 E2E와 media 결과

## 요구사항

- `R1`
- `R2`
- `R3`
- `R4`
- `R5`
- `R6`
- `R7`

## 허용 범위

- `AGENTS.md`
- `README.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md`
- `.claude/commands/setup.md`
- `scripts/CLAUDE.md`
- `src/CLAUDE.md`
- `docs/PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/UI_GUIDE.md`
- `docs/decisions/README.md`
- `docs/decisions/0023-installation-and-first-run-ux.md`

## 금지 및 중단 조건

- 코드와 test가 확정하지 않은 install, port, browser, selector 또는 retry behavior를 문서화하지 않는다.
- repository가 pre-clone agent host 정책을 강제로 제어한다고 주장하지 않는다.
- 기존 ADR 0012, 0014, 0016, 0020을 rewrite하거나 삭제하지 않는다.
- end-user quick start를 fixed `localhost:3000` 또는 foreground `npm run dev`로 유지하지 않는다.
- dormant 질문 기능을 현재 active product pipeline으로 소개하지 않는다.
- 문서 링크를 위해 code나 dependency를 바꾸지 않는다.
- 허용 경로 밖 수정이 필요하면 중단한다.

## 작업

1. README 첫 문단과 How it works를 현재 local-first storage, CLI/Ollama provider 경계와 active view/search/export에 맞춘다.
2. Quick start는 `node scripts/bootstrap.mjs --launch`, actual URL 출력, status/stop과 unavoidable permission만 보여 준다. Contributor `npm run dev`는 CONTRIBUTING으로 분리한다.
3. AI agent install section에 target 결정, ancestor/global no-touch, prerequisite authority, absolute path/URL handoff를 self-contained하게 쓴다.
4. AGENTS 설치 절차를 bootstrap 정본으로 바꾸고 `npm run dev`를 agent 설치 성공 경로에서 제거한다. command table에는 bootstrap과 app start/status/stop, contributor dev를 구분한다.
5. Claude `/setup` command가 같은 target/doctor/bootstrap/browser handoff를 수행하도록 맞춘다.
6. `scripts/CLAUDE.md`는 bootstrap의 stdlib, ownership, injected test 경계를, `src/CLAUDE.md`는 model selector/discovery/first-use/retry 상태 계약을 기록한다.
7. PRD는 `회의 녹음 시작`, first-use 비차단 안내, summary default와 active/dormant product 소개를 갱신한다.
8. ARCHITECTURE는 runtime state가 app data writer와 분리되는 이유, dynamic app/STT env, browser open과 local guard, model discovery DTO/caps, persisted health와 transcribe retry 재사용을 기록한다.
9. UI_GUIDE는 readiness card, settings order, native selector/custom states, auto health, failure/retry focus, responsive 기준을 상태표에 반영한다.
10. ADR 0023을 추가해 결정, 이유, 버린 대안, 기존 ADR과 영향 경로를 기록하고 ADR index에 등록한다.
11. CHANGELOG에 사용자 관점의 install/first-run/retry 개선을 기록하고 one-command install roadmap 항목을 실제 상태에 맞춰 정리한다.

## 테스트 (먼저 작성)

문서 전용 phase라 새 code test를 작성하지 않는다. 모든 behavior는 Phase 1~4의 test가 소유한다. command, label, route와 file link를 source와 대조하고 모순이 있으면 문서를 맞추되 behavior를 새로 발명하지 않는다.

## 문서 최신화

이 phase 자체가 정본 문서 갱신이다. historical ADR은 보존하고 신규 ADR 0023만 추가한다.

## 완료 게이트

```bash
npm run check:links
```
