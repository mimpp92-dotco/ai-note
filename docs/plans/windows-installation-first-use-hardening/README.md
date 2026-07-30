# Windows installation and first-use hardening

## 배경과 목표

macOS에서는 저장소 URL을 받은 에이전트가 clone부터 첫 화면 사용까지 완료했지만, Windows에서는 로컬 웹 주소가 열려도 본문·글자·콘텐츠가 보이지 않는 사례가 있었다. 공유된 설치 기록에는 기존 AI NOTE 서버와 새 build의 충돌, `uv.exe` 탐색 실패, `ffmpeg` 미설치 상태의 긴 health 대기, Codex 데스크톱 앱 패키지와 독립 CLI 혼동, 설치 뒤 오래된 `PATH`를 가진 프로세스가 계속 실행된 문제가 함께 기록돼 있다.

이 계획은 팀원이 별도로 만든 전사 진행률 등 사용성 개선을 가져오지 않는다. 저장소 URL 전달 → clone → canonical bootstrap → 실제 AI NOTE 첫 화면이라는 설치 경계만 보강한다. Windows에서 재현 가능한 환경·프로세스 문제를 고치되 macOS의 정상 경로와 로컬 단일 사용자·무자동설치 원칙을 유지한다.

## 관찰 사실과 제한된 추론

### 관찰된 사실

- Windows에서 브라우저는 열렸지만 AI NOTE의 실제 내용이 보이지 않았다.
- 공유 문서의 해결 과정에는 기존 서버/포트, `spawn uv.exe ENOENT`, `ffmpeg` 누락, WindowsApps의 Codex 실행 파일 권한 오류, 독립 Codex CLI 설치 뒤 프로세스 재시작이 포함돼 있다.
- 현재 `--launch`는 `npm ci`와 build를 먼저 실행한 뒤 owned runtime 존재 여부를 확인한다. 실행 중인 Next 서버가 있으면 같은 runtime을 재사용하므로 서버가 읽는 `.next`를 설치 흐름이 먼저 바꿀 수 있다.
- 현재 성공 판정은 앱 root의 HTTP 응답과 Whisper health에 머물며, root가 AI NOTE HTML인지와 첫 화면의 `/api/library` 표면이 읽히는지는 확인하지 않는다.
- Windows prerequisite 탐색은 대문자 `PATH`·`PATHEXT`만 읽고, supervisor의 Whisper 실행은 doctor가 찾은 경로가 아니라 다시 bare `uv.exe`에 의존한다.
- Codex health는 `ENOENT`만 별도 처리하고 `EACCES`·`EPERM`은 일반 오류로 낮춘다.

### 이 계획이 단정하지 않는 것

- 빈 화면의 단일 원인이 기존 runtime이라고 단정하지 않는다. Runtime/build 불일치는 관찰된 위험이고, 라이브러리 readiness 누락은 현재 검증 공백이다. 두 경계를 각각 회귀로 막는다.
- 모든 WindowsApps 경로가 Codex 데스크톱 앱이라고 추측하지 않는다. `%ProgramFiles%\WindowsApps\OpenAI.Codex_*`가 명확한 첫 후보일 때만 선택적 경고를 낸다.
- Windows의 모든 shell·package-manager 차이를 일반화하지 않는다. 현재 argv 기반 `shell: false` 실행을 유지하고, 실제 Windows smoke가 새 blocker를 증명하면 이 계획을 몰래 확장하지 않고 amendment에서 다룬다.

## 합의된 요구사항

### R1 — 실행 중 runtime과 설치 mutation의 분리

- `--launch`는 `npm ci`, `npm run build`, `node_modules`·`.next` 변경 전에 repository-owned runtime 상태를 판정한다.
- Runtime이 없을 때만 기존 doctor → install → build → background start 순서를 수행한다.
- Owned runtime이 있으면 자동 종료·재시작·install·build를 하지 않는다. 현재 runtime을 검증하고 실제 URL을 열되, 이번 source/PATH/install 변경은 적용되지 않았음을 구분해 알린다.
- 변경 적용이 필요하면 진행 중 녹음이 없는지 확인한 뒤 사용자가 `npm run app:stop`과 `--launch` 재실행을 명시적으로 수행한다.
- Stale·invalid·unsafe·소유권 불명 runtime은 process signal이나 build mutation 없이 fail-closed한다.

### R2 — 첫 사용 가능 표면까지의 좁은 smoke

- 새 runtime과 기존 owned runtime 모두 app health, Whisper health, AI NOTE root HTML, 기존 `/api/library`의 지원되는 public mode를 bounded probe로 확인한다.
- `AI_NOTE_URL`은 이 검증이 끝난 뒤에만 성공 URL로 출력한다.
- `/api/library`의 `ready`, `degraded_last_good`, `degraded_fallback`은 앱이 설명 가능한 지원 상태로 취급하고, 손상·상위 버전·I/O 오류를 bootstrap이 직접 복구하거나 덮어쓰지 않는다.
- 실패 출력에는 raw HTML/JSON, 파일 경로, PID/token, provider output을 싣지 않는다.
- 새 health API, 모든 Next.js asset 파싱, UI loading/error 개편은 추가하지 않는다. 실제 렌더링은 기존 synthetic browser smoke가 검증한다.

### R3 — Windows 환경·실행 파일·startup failure 일관성

- Windows의 환경 키는 case-insensitive하게 정규화하고 inherited `Path`/`PATH`, `PATHEXT` 중 실제 child에 전달할 값과 doctor가 탐색할 값을 하나로 맞춘다.
- 중복 PATH 값을 합치지 않는다. 명시적 child override가 case-insensitive하게 inherited 값보다 우선하며 child에는 동일 의미의 키를 하나만 전달한다.
- Doctor와 supervisor는 같은 resolver 규칙으로 찾은 `uv.exe`의 exact 경로를 사용한다. 이를 runtime state에 저장하거나 새 schema를 만들지 않는다.
- 공백이 든 repository·실행 파일 경로도 argv 배열과 `shell: false`로 실행한다.
- Whisper가 현재 public health 계약으로 `ffmpeg` 누락을 명확히 보고하면 3분 timeout까지 기다리지 않고 정적인 Windows 조치와 재실행 명령으로 종료한다.
- Supervisor가 ready가 되기 전 interrupt/error가 나면 이번 시도에서 얻은 child handle만 정리한다. 전역 PID·port scan이나 소유권 불명 process 종료는 하지 않는다.

### R4 — Codex 데스크톱 앱과 독립 CLI의 보수적 진단

- Doctor의 첫 Codex 후보가 명확한 `%ProgramFiles%\WindowsApps\OpenAI.Codex_*` package 경로일 때만 데스크톱 앱이 독립 CLI 대신 선택됐을 가능성을 경고한다.
- 이 경고와 Codex 미설정은 녹음·전사의 설치 blocker가 아니다.
- Windows `EACCES`·`EPERM` health 실패는 권한 차단, 독립 Codex CLI/PATH 확인, 새 PowerShell과 owned AI NOTE runtime 재시작이라는 안전한 조치를 반환한다.
- Windows `ENOENT`도 독립 CLI 설치 뒤 shell/runtime을 재시작해야 새 PATH가 반영된다고 안내한다.
- Non-Windows 문구와 `codex --version` 수준의 감지 계약은 유지한다.
- 다른 디렉터리 자동 검색·우회 실행, absolute Codex path 저장, 로그인·인증 실행, 모델 선택·생성 흐름 변경은 하지 않는다.

### R5 — Windows 최소 회귀와 synthetic first-use 증거

- `windows-latest` job은 pinned Node, `npm ci`, setup/bootstrap/Codex 대상 테스트, secret 없는 build, Chromium 설치·doctor, 기존 `e2e/smoke.spec.ts`만 실행한다.
- Smoke는 기존 evidence reporter가 요구하는 desktop-1440, mobile-390, mobile-320을 모두 사용한다.
- E2E source snapshot 경로에 공백을 의도적으로 포함해 Windows 경로 quoting을 계속 검증한다.
- Windows job은 실제 마이크, 사용자 data, Whisper model, `uv`/`ffmpeg` service, Codex 로그인, 외부 LLM을 사용하지 않는다.
- 전체 Windows E2E suite나 새 browser spec을 추가하지 않는다. Bootstrap lifecycle은 주입식 회귀, browser hydration은 기존 smoke로 분리해 검증한다.

### R6 — 정본 설치 문서의 일치

- README, CONTRIBUTING, AGENTS, ARCHITECTURE, scripts module guide, Claude `/setup`, 기존 ADR 0023을 최종 runtime fence·first-use smoke·Windows PATH/Codex 조치와 일치시킨다.
- ADR 0023은 기존 결정을 삭제하지 않고 Windows에서 드러난 후속 제약을 기록한다.
- 새 ADR, PRD, UI guide, changelog 변경은 만들지 않는다. 제품 목표와 시각 동작이 바뀌지 않기 때문이다.

## 비목표

- 공유 문서 작성자가 추가한 전사 진행률·퍼센트·단계별 UI
- 일반적인 첫 실행 loading/error 화면 개편
- ZIP·MSI·signed installer, Electron, Docker, WSL 설치 경로
- `uv`, `ffmpeg`, Codex CLI 자동 설치 또는 package manager·`sudo` 자동 실행
- Codex 자동 로그인·인증 확인·모델 다운로드
- Runtime build fingerprint, state schema, absolute Codex executable 설정
- 새 API, dependency, file format, ADR
- 모든 Next.js JS/CSS asset을 내려받아 파싱하는 bootstrap crawler
- 전역 process scan·port owner 종료·owned runtime 자동 재시작
- 실제 Windows 증거 없이 npm `.cmd` 실행 방식을 바꾸는 일

## 주요 제약

- 기존 runtime은 녹음 중일 수 있으므로 bootstrap이 자동으로 종료하지 않는다.
- `data/`, `glossary.json`, `.env*`와 실제 회의·provider credential을 읽거나 쓰지 않는다.
- App/Whisper는 계속 `127.0.0.1`에만 bind하고 browser용 canonical URL은 `localhost:<actual-port>`다.
- 라이브러리 bootstrap/reconcile은 기존 `/api/library` writer 경계가 수행하며 `scripts/bootstrap.mjs`가 data 파일을 직접 쓰지 않는다.
- Windows PATH를 고친 뒤에는 새 shell뿐 아니라 이미 실행 중인 owned supervisor도 명시적으로 재시작해야 한다.
- macOS/Linux의 정상 동작과 기존 오류 문구는 Windows 분기가 필요하지 않은 곳에서 유지한다.

## Phase

| Phase | 이름 | 핵심 결과 | 검증 |
|---|---|---|---|
| 1 | windows-safe-bootstrap-and-codex-diagnostics | pre-mutation ownership fence, first-use surface probe, Windows env/uv/ffmpeg/cleanup, Codex 진단 | 주입식 regression + typecheck/lint |
| 2 | windows-synthetic-smoke-ci | 공백 snapshot 경로와 최소 Windows build/browser smoke job | 기존 harness contract + build |
| 3 | installation-contract-docs | README·agent·architecture·setup·ADR 0023 일치 | link check |
| 4 | synthetic-first-use-verification | 세 viewport에서 실제 AI NOTE 콘텐츠와 외부 요청 0 검증 | repository Playwright |

## 실행 방법

```bash
/execute windows-installation-first-use-hardening
```

- Publish strategy는 `single-pr`이며 phase는 한 branch에 검증 가능한 commit으로 쌓는다.
- Source baseline은 `main`의 `1a7e658982834743a1a9fcc9ad2e7e692eb130fd`다.
- Task worktree에는 의존성을 복사하지 않는다. 실행 전에 그 worktree에서 `npm ci`가 필요하다.
- Browser preflight는 `npm run test:e2e:doctor`, 검증은 `npm run test:e2e`다.
- Windows hosted runner 결과는 push 뒤 merge gate에서 확인한다. 로컬 verify-only phase가 Windows 실행을 했다고 과장하지 않는다.
- Allowed path 밖 변경이나 npm invocation redesign이 필요하면 추측해 범위를 넓히지 않고 중단한다.

## 문서 업데이트 대상

- `README.md`
- `CONTRIBUTING.md`
- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/decisions/0023-installation-and-first-run-ux.md`
- `scripts/CLAUDE.md`
- `.claude/commands/setup.md`

## 고정된 가정

- 이번 목표의 “첫 사용”은 앱 shell과 라이브러리 콘텐츠 표면이 실제 browser에서 렌더되는 시점이다. 첫 실제 녹음·model download·요약 생성은 포함하지 않는다.
- Codex는 optional summarizer다. 감지 실패가 AI NOTE 설치·녹음·전사를 실패시키지 않는다.
- 기존 owned runtime이 있으면 사용자 데이터 보호가 source update 자동 적용보다 우선한다.
- `/api/library`의 지원되는 degraded mode는 UI가 설명할 수 있는 사용 가능 상태이며 bootstrap이 registry를 임의 복구하지 않는다.
- 빈 화면 원인이 하나로 확정되지 않았으므로 runtime/build fence와 browser smoke를 독립적으로 검증한다.
