# Phase 1 — Safe bootstrap and owned runtime

## 목표

Node만 있는 fresh clone에서 실행할 수 있는 하나의 bootstrap을 만들고, 설치·빌드·동적 loopback port·background lifecycle·health·browser open을 repository가 소유하는 경로로 묶는다. 기존 폴더나 실행 중인 다른 프로젝트를 추측으로 수정하거나 종료하지 않는다.

## 읽어야 할 파일

- `AGENTS.md`
- `README.md`
- `.claude/commands/setup.md`
- `.gitignore`
- `package.json`
- `package-lock.json`
- `scripts/CLAUDE.md`
- `scripts/setup.mjs`
- `scripts/__tests__/setup.test.mjs`
- `src/lib/config.ts`
- `whisper/server.py`

## 요구사항

- `R1`
- `R2`
- `R7`

## 허용 범위

- `.gitignore`
- `package.json`
- `scripts/setup.mjs`
- `scripts/bootstrap.mjs`
- `scripts/__tests__/setup.test.mjs`
- `scripts/__tests__/bootstrap.test.mjs`

## 금지 및 중단 조건

- 전역 금지: `data/**`, `.env*`, `glossary.json`, `package-lock.json`, `whisper/**`, `fixtures/**`, `.github/**`, `.husky/**`, `docs/plans/**`, summary domain/publisher 파일.
- 기존 target, ancestor repository, 사용자 home 또는 global config를 수정해야 하면 중단한다.
- `127.0.0.1` 외 bind, `.env.local` rewrite 또는 다른 process 종료가 필요하면 중단한다.
- stale state의 PID와 current supervisor ownership token을 확인할 수 없으면 signal을 보내지 않고 안전하게 중단한다.
- browser open에 Playwright, extension, MCP 또는 새 dependency가 필요하면 중단한다.
- test가 실제 `npm ci`, build, 장기 child, OS browser, network, model download를 실행해야 하면 중단한다.
- 허용 경로 밖 수정이 필요하면 중단한다.

## 작업

1. 실패 test로 canonical CLI와 pure helper 계약을 먼저 고정한다.
   - `--launch`, `start`, `status`, `stop`, internal supervisor mode 외 입력 거부
   - repository root와 runtime state path의 exact resolve
   - app 3000, Whisper 8123부터 bounded candidate 선택
   - 점유·bind race에서 다음 candidate, 범위 소진에서 명확한 실패
   - shell interpolation 없는 OS별 browser opener argv 생성과 headless fallback
   - live heartbeat/token이 일치할 때만 owned 상태로 판정
   - stale/unreadable/symlink state는 kill 없이 fail-closed
2. `scripts/bootstrap.mjs`를 Node stdlib와 injectable side-effect adapter만으로 구현한다.
3. default bootstrap 흐름을 다음 순서로 고정한다.
   - repository root 확인
   - existing doctor 실행
   - `HUSKY=0 npm ci`
   - `npm run build`
   - owned supervisor 시작
   - app root와 `/api/whisper/health` 준비 확인
   - exact `AI_NOTE_URL=http://localhost:<port>` 출력
   - supported desktop browser open 또는 exact fallback 안내
4. supervisor는 선택한 app/Whisper port를 child env에만 넣고 두 service를 `127.0.0.1`에 기동한다. repository-local ignored runtime directory에 제한된 mode로 최소 state, token, heartbeat, logs만 두며 inherited environment와 credential은 기록하지 않는다.
5. `app:status`는 URL, child readiness와 log 위치를 안전하게 보고하고, `app:stop`은 fresh heartbeat/token으로 current supervisor를 증명한 경우에만 종료한다. 종료 후 owned state만 정리한다.
6. `package.json`에 end-user bootstrap과 start/status/stop scripts를 추가하고 기존 `dev`와 dependency versions를 바꾸지 않는다.
7. `setup.mjs`의 성공 안내는 foreground `npm run dev` 대신 bootstrap 재개 경로를 우선하고 contributor command를 별도로 둔다.

## 테스트 (먼저 작성)

- `scripts/__tests__/bootstrap.test.mjs`를 먼저 추가해 path, command construction, port fallback, health timeout, browser fallback, stale ownership과 stop 안전성을 RED로 확인한다.
- child spawn, filesystem, clock, port probe와 opener는 모두 주입한다.
- temp directory 밖 파일, 실제 port, process, package manager, browser, model과 network를 사용하지 않는다.
- 기존 `setup.test.mjs`는 doctor가 prerequisite를 정직하게 구분하고 새 재개 command를 안내하는지 갱신한다.

## 문서 최신화

공개 설치 문서와 Claude setup command는 Phase 5에서 검증된 CLI에 맞춰 갱신한다. 이 phase에서는 executable script, package entry와 ignore 규칙만 변경한다.

## 완료 게이트

```bash
npm test -- scripts/__tests__/setup.test.mjs scripts/__tests__/bootstrap.test.mjs
npm run lint -- scripts/setup.mjs scripts/bootstrap.mjs scripts/__tests__/setup.test.mjs scripts/__tests__/bootstrap.test.mjs
```
