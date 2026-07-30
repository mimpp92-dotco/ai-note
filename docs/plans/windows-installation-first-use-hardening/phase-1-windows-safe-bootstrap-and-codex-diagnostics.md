# Phase 1 — Windows-safe bootstrap and Codex diagnostics

설치 mutation보다 runtime ownership을 먼저 판정하고, Windows doctor와 실제 child process가 같은 환경·실행 파일을 보도록 만든다. 성공 기준은 포트 응답이 아니라 AI NOTE root와 library surface까지 준비된 상태다.

## 읽어야 할 파일

AGENTS와 ADR 0023의 owned-runtime 경계, bootstrap/setup의 command·health·ownership 흐름, library public route와 supported mode, Codex adapter의 binary-only health 및 해당 회귀 테스트를 읽는다. Node의 Windows child environment가 case-insensitive key를 다루는 현재 동작도 구현 근거로 확인한다.

## 요구사항

- R1의 pre-mutation ownership fence와 명시적 restart 절차를 구현한다.
- R2의 app·Whisper·root identity·library surface readiness를 launch/status에 적용한다.
- R3의 case-insensitive environment, exact uv path, ffmpeg terminal failure와 pre-ready cleanup을 구현한다.
- R4의 보수적인 WindowsApps warning과 Codex `EACCES`·`EPERM`·`ENOENT` 조치를 구현한다.

## 허용 범위

설치 doctor·bootstrap과 그 주입식 테스트, Codex health와 해당 adapter 테스트만 수정한다. Library route·service는 public contract를 읽기만 하고 변경하지 않는다.

## 금지 및 중단 조건

- Owned runtime을 자동 종료·재시작하거나 녹음 상태를 추측하지 않는다.
- Stale·invalid·unverifiable PID에 signal을 보내지 않고 전역 process/port를 검색하지 않는다.
- Runtime state/build fingerprint, `.env.local`, 새 API·dependency·UI를 추가하지 않는다.
- PATH 중복 값을 이어 붙이거나 shell command string을 만들지 않는다.
- Codex alternate location 탐색·실행, absolute path 설정, login/auth, generation/model 동작을 추가하지 않는다.
- 실제 Windows runner가 npm `.cmd` 문제를 증명하면 이 phase에서 임의 해결하지 않고 amendment 대상으로 중단한다.

## 작업

1. 기존 주입 경계로 owned/absent/unsafe runtime을 install command 전에 판정하는 실패 테스트를 먼저 만든다.
2. Owned 결과는 install/build/start를 호출하지 않고 현재 runtime의 네 readiness surface를 검증한 뒤 exact URL과 “이번 update 미적용” 상태를 반환하게 한다.
3. Absent 결과만 기존 doctor → `HUSKY=0 npm ci` → build → start를 수행하고, unsafe 결과는 mutation과 signal 0으로 중단한다.
4. Root probe는 bounded response에서 AI NOTE HTML identity만 확인하고 `/api/library`는 public `mode` allowlist만 판정한다. Body나 internal error를 출력하지 않는다.
5. Windows environment helper는 case-insensitive key마다 하나의 effective entry를 만들고 Node child와 호환되는 inherited precedence 위에 explicit child override를 적용한다. Doctor의 `which`와 spawn env가 이를 공유한다.
6. `uv.exe`는 같은 resolver로 얻은 exact path를 `buildRuntimeCommandPlan`에 넘긴다. 공백 경로도 단일 argv 값으로 유지하고 runtime state에는 기록하지 않는다.
7. Whisper의 현재 `ffmpeg` missing public 상태만 terminal health로 분류해 static remediation을 즉시 반환한다. 다른 not-ready 상태는 기존 bounded retry를 유지한다.
8. Supervisor가 ready를 알리기 전에 signal/error가 발생해도 현재 시도가 만든 app/Whisper child handle만 idempotent cleanup하도록 handler 설치 시점을 보강한다.
9. Setup doctor는 첫 Codex path가 명확한 Program Files WindowsApps `OpenAI.Codex_*` package일 때만 warning을 추가한다. Codex adapter는 Windows permission/not-found 조치를 safe message로 구분한다.

## 테스트 (먼저 작성)

- `Path`만 있는 환경, `PATH`/`Path` 중복, mixed-case `PATHEXT`, explicit override와 공백 경로를 고정한다.
- Doctor가 성공시킨 uv exact path와 runtime command가 일치하고 bare `uv.exe`로 퇴행하지 않는지 검증한다.
- Owned runtime에서는 install/build/start 0회, unsafe runtime에서는 mutation/signal 0회인지 검증한다.
- Root identity와 library supported/degraded mode success, malformed/unsupported response의 safe failure를 검증한다.
- `ffmpeg` missing은 첫 terminal 응답에서 끝나고 generic not-ready는 retry하는지 검증한다.
- Pre-ready interrupt/error가 이번 시도의 child handle만 한 번 정리하는지 검증한다.
- WindowsApps 명확 경로만 warning하고 일반 standalone path는 warning하지 않는지 검증한다.
- Codex Windows `EACCES`·`EPERM`·`ENOENT`와 기존 non-Windows message를 검증한다.

## 문서 최신화

이 phase에서는 문서를 수정하지 않는다. 최종 동작은 Phase 3에서 코드·테스트 결과와 대조해 정본에 반영한다.

## 완료 게이트

```bash
npm test -- scripts/__tests__/setup.test.mjs scripts/__tests__/bootstrap.test.mjs src/services/llm/__tests__/codexCli.test.ts
npm run typecheck
npm run lint -- scripts/setup.mjs scripts/bootstrap.mjs scripts/__tests__/setup.test.mjs scripts/__tests__/bootstrap.test.mjs src/services/llm/codexCli.ts src/services/llm/__tests__/codexCli.test.ts
```
