# Installation and first-run UX

## 상태와 기준선

- 상태: 사용자 승인 완료, `/execute` 가능한 구현 계약
- Base: `main` @ `e24ad30dc8e07c21a13b43062c68a4445d984ebc`
- Task branch: `execute/installation-and-first-run-ux`
- Publish: 한 개 PR을 전제로 한 `single-pr`
- 구현 범위의 정본: [`plan.json`](plan.json)

이 계획은 저장소 URL만 전달받은 AI 에이전트가 안전한 위치에 clone하고, 설치·빌드·로컬 서버 기동·실제 URL의 브라우저 열기까지 이어서 완료하는 경험을 만든다. 앱에서는 요약 모델 설정을 놓치지 않게 안내하되 녹음을 막지 않고, provider별 모델 선택과 직접 입력, 실제 전사 재시도, 완료 회의의 요약 우선 열람을 한 번에 정리한다.

다른 worktree에 `docs/plans/local-dev-and-synthetic-qa` 같은 이전 로컬 초안이 남아 있더라도 이 계획이 후속 구현의 정본이다. 고정 3000/8123, 자동 port fallback 금지, Chrome DevTools MCP 필수 연결 같은 이전 가정은 실행하지 않는다.

## 확인된 현재 문제

1. 저장소 외부의 작업 폴더에 `.claude`, `.harness`, `.git` 등이 있으면 설치 에이전트가 현재 폴더를 덮을지 물을 수 있다. 저장소는 clone 전 host 동작을 직접 강제할 수 없으므로 README와 AGENTS에 안전한 target 결정 계약을 공개하고, target 내부만 수정하게 해야 한다.
2. 현재 doctor는 `npm install && npm run dev`만 출력한다. 장기 실행 process를 사용자 터미널에 남기고 browser open을 하지 않는다.
3. README와 agent 절차는 `localhost:3000`을 고정 안내한다. 3000이 다른 앱에 점유돼도 사용자는 그 URL을 열어 잘못된 프로젝트를 볼 수 있다.
4. 홈의 미설정 상태는 sidebar health에만 의존해 사용자가 바로 녹음을 누르기 쉽다. 설정 페이지도 선택적인 개인화가 모델보다 먼저 나온다.
5. 모델은 free text 하나라 provider별 유효 범위, CLI 기본값, 설치된 Ollama 모델을 알기 어렵다. 오타는 앱이 fuzzy match하지 않고 backend에 그대로 전달된다.
6. `RecorderFinalizeResultView`의 `전사 다시 시도`는 `/api/transcribe`를 호출하지 않고 finalize probe만 다시 한다. 목록 badge도 `retry_transcription`을 별도로 처리하지 않아 실패가 `전사 중`처럼 남는다.
7. 완료 회의는 요약이 있어도 기본으로 전체 스크립트를 열고, 사용자 문구 일부에 `best-effort`와 활성화되지 않은 질문 pipeline이 섞여 있다.

## 목표 사용자 흐름

```text
repo URL 전달
  → 기존 폴더와 격리된 target 결정·clone
  → prerequisite doctor와 필요한 권한만 처리
  → node scripts/bootstrap.mjs --launch
  → npm ci + build
  → 비어 있는 app/Whisper loopback port 선택
  → owned background runtime health 확인
  → 실제 localhost URL을 OS 또는 agent browser로 열기
  → 첫 화면의 비차단 요약 설정 안내
  → provider/model 선택·저장·자동 상태 확인
  → 첫 회의 녹음
```

일반 성공 경로에서 사용자가 터미널의 `cd`나 `npm run dev`를 다시 입력할 필요가 없어야 한다. 다만 다음 세 가지는 저장소가 대신 승인할 수 없다.

- Node, uv, ffmpeg 설치에 필요한 OS 관리자 권한
- Claude/Codex 로그인 또는 사용자가 선택한 Ollama 모델 pull
- 브라우저 마이크 권한

이 경우에만 정확한 조치와 재개 command를 보여 주고, 나머지는 에이전트가 계속 진행한다.

## 합의된 핵심 결정

### 설치 위치

- 명시 target이 없으면 현재 폴더 자체에 설치하지 않는다.
- 현재 위치가 다른 Git repository 안이면 그 repository root의 sibling을 사용한다.
- 그 밖에는 현재 위치 아래 새 `ai-note` child를 사용한다.
- 같은 이름이 이미 있으면 기존 내용을 건드리지 않고 deterministic suffix를 붙인 새 디렉터리를 선택한다.
- parent `.git`, `.claude`, `.harness`, global git config와 다른 프로젝트 process는 범위 밖이다.

### 실행 방식

- end-user/agent 정본은 `node scripts/bootstrap.mjs --launch`다.
- `npm run dev`는 contributor foreground command로 유지한다.
- 기본 후보는 app 3000, Whisper 8123이지만 점유돼 있으면 bounded next candidate를 사용한다.
- 둘 다 `127.0.0.1`에만 bind하고 browser용 정본 URL은 `http://localhost:<actual-port>`다.
- OS browser open은 best effort다. headless 환경에서는 정확한 URL을 출력하고 에이전트가 in-app browser나 Chrome surface로 연다.
- Playwright는 제품 실행 도구가 아니라 isolated synthetic 회귀 gate다.
- background process는 repository-local ignored state와 live heartbeat token으로 소유권을 증명한다. 검증할 수 없는 PID는 종료하지 않는다.

### 첫 사용

- 별도 tutorial route나 modal tour를 만들지 않는다.
- 홈 recorder 앞의 readiness card가 `AI 요약 설정`과 `요약 없이 회의 녹음`을 함께 제공한다.
- 설정은 요약 모델이 먼저, 선택적인 내 정보가 다음이다.
- 저장 직후 persisted 설정을 자동 검사한다.
- Claude/Codex는 binary 수준의 `감지됨`, Ollama는 local model까지 확인한 `연결됨`으로 구분한다.
- 첫 Whisper 전사는 model download 때문에 오래 걸릴 수 있음을 정직하게 안내한다.

### 모델 선택

| Provider | 선택지 |
|---|---|
| Claude CLI | `CLI 기본값(권장)`, `Sonnet`, `Opus`, `Haiku`, `직접 입력` |
| Codex CLI | `CLI 기본값(권장)`, `직접 입력` |
| Ollama | 현재 local `/api/tags`의 설치 모델, `새로고침`, `직접 입력` |

- CLI 기본값은 `model`을 저장하지 않는다.
- Claude aliases는 각각 `sonnet`, `opus`, `haiku`를 저장한다.
- Codex의 versioned catalog나 experimental model-list command는 사용하지 않는다.
- unknown saved model과 custom 입력은 exact 문자열을 보존한다.
- app은 오타를 fuzzy match하거나 존재하는 모델이라고 보장하지 않는다.
- Ollama discovery만 새 guarded local API를 사용하며 remote catalog나 자동 pull은 없다.

### 전사 실패

- 목록, finalize 결과, 상세에서 `전사 실패`를 지속적으로 표시한다.
- 두 retry CTA 모두 existing `POST /api/transcribe {id}`를 호출한다.
- durable dispatch identity, tombstone fence, operation lease와 raw-last publication 계약은 바꾸지 않는다.
- UI는 artifact를 직접 쓰지 않는다.

## 범위 밖

- Docker, Electron, installer package, menubar app, OS login autostart
- LAN bind, hosted backend, account, telemetry, API key 저장
- Claude/Codex remote model catalog, Ollama 자동 pull, Whisper model 선다운로드
- provider 로그인 자동화 또는 CLI health를 실제 생성 성공으로 확대
- 별도 onboarding route, product tour framework, analytics funnel
- workspace/folder/search/editor/summarize publisher 재설계
- 질문/회의 도우미 활성화
- 전체 visual redesign 또는 새 UI/runtime dependency
- 사용자 환경의 모든 AI agent가 repository 문서를 읽기 전부터 같은 clone 정책을 따른다는 보장

## Phase

| Phase | 결과 | 위험도 | 핵심 검증 |
|---|---|---:|---|
| 1 | 안전한 bootstrap과 owned runtime lifecycle | critical | 주입식 script TDD, targeted lint |
| 2 | first-use readiness와 provider별 model selector | critical | RTL + route/adapter TDD, typecheck |
| 3 | 실제 transcription retry와 완료 회의 기본 summary | standard | component TDD, typecheck |
| 4 | synthetic first-run/retry browser scenario와 현재 screenshot | standard | fixture TDD + 3 viewport Playwright |
| 5 | 공개 문서와 ADR 0023 | low | link check |
| 6 | 변경 없는 최종 synthetic browser gate | standard | verify-only Playwright evidence |

## 안전·데이터 경계

- `data/**`, `.env*`, `glossary.json`, 실제 audio/transcript/summary는 어떤 test에도 사용하지 않는다.
- app과 Whisper는 계속 explicit loopback에만 bind한다.
- 새 Ollama discovery route는 guard를 request parse, settings/filesystem, local fetch보다 먼저 실행한다.
- provider output, path, PID token, dispatch ID와 raw filesystem error는 browser DTO에 노출하지 않는다.
- runtime state는 source-controlled data contract와 분리된 ignored directory에만 둔다.
- bootstrap test는 실제 install, build, server, browser, model 또는 external network를 실행하지 않는다.

## 검증 기준

Plan 작성 전 base 상태에서 설치·설정 관련 targeted unit 6개 파일의 144개 test와 기존 synthetic Playwright 6개 case가 통과했고, Playwright doctor도 pinned Chromium 정합을 확인했다. 이 결과는 변경 전 baseline이며 구현 완료 증거를 대신하지 않는다.

구현 완료 시 다음 gate를 새 worktree에서 다시 통과해야 한다.

```bash
npm test
npm run typecheck
npm run lint
npm run check:links
npm run build
npm run test:e2e:doctor
npm run test:e2e
```

Playwright 성공 evidence는 desktop 1440, mobile 390, mobile 320의 screenshot, assertion, console과 manifest를 포함하며 `test-results/` 또는 execute local journal에만 둔다.

## 실행 handoff

이 plan은 구현을 포함하지 않는다. 구현은 task worktree에서 다음과 같이 시작한다.

```bash
/execute docs/plans/installation-and-first-run-ux
```

Task worktree에 dependency가 없으면 먼저 `npm ci`가 필요하다. 일반 앱 사용자는 구현 완료 뒤 README의 `node scripts/bootstrap.mjs --launch` 경로를 사용하며 Playwright browser 설치는 필요하지 않다.
