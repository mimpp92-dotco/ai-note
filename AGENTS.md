# AI NOTE — 회의 녹음 → 회의록 요약

> 모델·도구 무관 **에이전트 진입점**. Claude Code·Codex 등 어떤 에이전트가 열어도 이 파일을 먼저 읽는다. `CLAUDE.md`는 이 파일의 심링크(내용 하나). 사람 온보딩은 [README.md](README.md).

로컬 단일 사용자 웹앱. 노트북 마이크 녹음 → 로컬 whisper 배치 전사 → 로컬 CLI(claude/codex)·Ollama 교정·요약 → 열람·내보내기. 상세 기획은 [docs/PRD.md](docs/PRD.md), 계약·데이터흐름은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), 디자인은 [docs/UI_GUIDE.md](docs/UI_GUIDE.md).

## 데이터 흐름 · Dependencies (cross-module)

```mermaid
flowchart LR
    R["src · Recorder UI"] -->|audio.webm| W["whisper · STT"]
    W -->|raw.md| S["최초 교정·요약 / 독립 재생성 · 로컬 CLI/Ollama"]
    S -->|transcript.md · summary.json| V["열람 · 수동 수정 · 내보내기"]
```

- 흐름: `src`(녹음/API) → `whisper`(HTTP 127.0.0.1) → 최초 교정·요약 또는 종류별 독립 재생성(로컬 CLI/Ollama) → 열람·수동 수정·내보내기. 단일 writer 소유권은 아래 CRITICAL 참조.
- 모듈별 상세: [src/CLAUDE.md](src/CLAUDE.md) · [whisper/CLAUDE.md](whisper/CLAUDE.md) · [scripts/CLAUDE.md](scripts/CLAUDE.md).
- 결정 기록(ADR): [docs/decisions/](docs/decisions/) · AI 기능 품질: [evals/](evals/).

## 기술 스택
- Next.js 15 (App Router) · TypeScript strict · Tailwind CSS
- 로컬 whisper 서비스: Python(**uv로 3.11/3.12 핀 venv**, 시스템 3.14 금지), 품질 우선 기본 `large-v3`와 선택형 `large-v3-turbo`(mlx-whisper, 폴백 faster-whisper), `127.0.0.1`
- 테스트: Vitest(+ RTL/jsdom component test) + 고정 버전 Playwright/Chromium synthetic browser 회귀. Chrome DevTools MCP는 선택적 정성 검토 전용이며 자동 gate가 아니다(ADR 0020).
- 저장: 로컬 파일(`data/meetings/{id}/`) — DB 없음.

## 설치 (Installation)

> 사람 대상 요약은 `README.md`. 아래 계약은 에이전트가 이 저장소의 공개 문서를 읽은 시점부터 적용된다. 저장소를 clone하기 전 agent host의 정책까지 이 저장소가 강제한다고 주장하지 않는다.

### 저장소 URL만 받은 에이전트

1. 먼저 설치 target을 absolute path로 결정하고 사용자에게 알린다.
   - 사용자가 target을 명시하지 않았으면 현재 디렉터리 자체에 설치하지 않는다. 현재 위치가 다른 Git 저장소 안이면 그 저장소 root의 sibling `ai-note`를, 아니면 현재 디렉터리 아래의 새 `ai-note`를 선택한다.
   - 기본 이름이 이미 있으면 재사용·덮어쓰기·`pull`하지 않는다. `ai-note-2`, `ai-note-3`처럼 첫 번째 비어 있는 deterministic suffix path를 선택한다.
   - 사용자가 명시한 target이 non-empty이거나 이미 다른 origin을 가리키면 중단하고 exact absolute path를 보고한다.
2. Clone과 이후 설치는 선택한 target 안에서만 수행한다. 상위 `.git`·`.claude`·`.harness`, 사용자 Git 설정, 다른 `package.json`, 실행 중인 프로젝트를 수정하거나 종료하지 않는다.
3. 단순 경로 충돌은 안전한 새 suffix target으로 해결한다. OS package 설치의 `sudo`/확인이나 provider 로그인처럼 새 권한이 필요한 경우에만 사용자 승인을 요청한다.

### Clone 뒤 정본 실행

1. **Node ≥ 20 확보** — `node -v`. 없거나 낮으면 nvm 또는 OS package manager 설치 명령을 사용자에게 보여 주고 필요한 권한을 받는다.
2. Target root에서 `node scripts/bootstrap.mjs --launch`를 실행한다. 이 무의존 command는 `node_modules`·`.next` mutation 전에 repository-local runtime ownership을 먼저 판정한다.
   - `absent`일 때만 doctor → `HUSKY=0 npm ci` → `npm run build` → repository-owned background app/Whisper 기동 순서를 수행한다.
   - `owned`이면 자동 stop/restart/install/build하지 않고 현재 runtime을 검증·개방하며 이번 install/update가 적용되지 않았음을 알린다. 변경 적용이 필요하면 사용자가 진행 중 녹음이 없는지 확인한 뒤 `npm run app:stop`을 실행하고 같은 `--launch` command를 다시 실행한다.
   - stale·invalid·unsafe·unverifiable이면 process signal과 build mutation 없이 fail-closed한다.
3. 새 runtime과 재사용한 owned runtime 모두 app health, Whisper health, AI NOTE로 식별되는 root HTML, 기존 `/api/library` public response의 네 bounded probe를 통과해야 한다. Library의 `ready`, `degraded_last_good`, `degraded_fallback`만 지원 상태이며 corrupt·unsupported version·I/O failure를 bootstrap이 복구하거나 덮어쓰지 않는다. Library data write는 기존 app-api owner만 수행한다.
4. Doctor가 필수 `uv` 또는 `ffmpeg` 누락으로 멈추면 출력된 OS별 조치를 사용자에게 보여 주고 설치한 뒤 같은 `--launch` command를 다시 실행한다. Whisper가 현재의 명확한 ffmpeg-missing public health를 반환하면 일반 timeout을 기다리지 않고 같은 설치·재실행 조치를 안내한다. Bootstrap은 `sudo`, package manager, provider 로그인, `ollama pull`, Whisper model download를 몰래 실행하지 않는다.
5. Windows에서는 `Path`/`PATH`와 `PATHEXT`를 case-insensitive effective child environment 하나로 해석하고 값을 합치지 않는다. Doctor와 supervisor는 같은 규칙으로 resolve한 exact `uv.exe`를 사용하며 공백 경로도 argv와 `shell:false`로 전달한다. 전제 도구나 독립 Codex CLI 설치 뒤 새 PowerShell을 열고, 이미 owned runtime이 있었다면 녹음이 없는지 확인해 `app:stop` 후 같은 `--launch`로 재기동한다.
6. 요약기는 녹음·전사의 설치 blocker가 아니다. 앱이 열린 뒤 **설정 → 요약 모델**에서 Claude/Codex CLI 또는 Ollama를 선택하고 저장한다. Windows에서 Codex desktop WindowsApps package는 독립 Codex CLI가 아니며, doctor warning이나 Codex health failure도 bootstrap을 막지 않는다. `codex --version` health는 binary 실행 감지일 뿐 인증·실제 요약 성공 보장이 아니다. 필요한 CLI 로그인, `ollama serve`/`ollama pull <model>`은 사용자 권한과 선택으로 수행하며 `data/settings.json`을 직접 쓰지 않는다.
7. 네 probe 성공 뒤에만 출력되는 `AI_NOTE_URL=http://localhost:<actual-port>`를 정본으로 사용한다. Headless/opener 실패도 server 성공을 유지하므로 출력된 exact URL을 사용 가능한 agent browser surface로 연다. 최종 handoff에는 absolute install path, branch 또는 revision, 실제 앱 URL을 함께 보고한다.

앱은 `127.0.0.1:3000`부터, Whisper는 `127.0.0.1:8123`부터 bounded 후보를 고르며 기존 process에 연결하거나 종료하지 않는다. 선택 포트는 child environment에만 전달하고 `.env.local`을 만들거나 덮어쓰지 않는다. Runtime state/heartbeat/log는 gitignored `.ai-note-runtime/`에 mode를 제한해 저장하며 credential이나 inherited environment를 기록하지 않는다. `npm run app:status`/`npm run app:stop`은 live ownership token이 검증된 supervisor만 조회·종료하고 stale 또는 검증 불가 PID에는 signal을 보내지 않는다.

Supervisor ready 전 interrupt/error cleanup은 이번 시도가 확보한 app/Whisper child handle에만 idempotent하게 적용한다. Global PID/port scan이나 소유권 불명 process signal은 금지한다. `app:status`도 네 readiness surface를 `app`·`whisper`·`root`·`library`로 구분하며 안전한 고정 오류만 외부에 낸다.

Claude Code 세션은 같은 계약의 `/setup` command를 사용할 수 있다. `npm run dev`는 contributor용 foreground command이며 end-user 설치 성공 경로가 아니다.

## 아키텍처 규칙

### CRITICAL — 반드시 지킬 것
- **TDD**: 새 기능은 테스트 먼저 작성 → 통과하는 구현.
- **원본 불가침**: `audio.webm`·`raw.md`·`segments.json`은 생성 후 수정 금지. `transcript.md`·`summary.json`만 재생성·수동 수정 가능한 파생물이다.
- **원자적·내구 쓰기**: 모든 아티팩트는 temp 파일 → file `fsync` → `rename` → parent-directory `fsync`로 쓴다. `rename`이 논리적 commit 지점이며 결과는 `not_committed | committed_durable | committed_best_effort | committed_durability_pending`으로 구분한다. rename 뒤 sync 실패를 rollback하거나 미커밋으로 오인하지 않는다(ADR 0011).
- **파일 소유권(단일 writer)**: `status.json`=app-api만, `data/library.json`=library repository만, `data/pipeline-settings.json`=pipeline settings app-api만, `raw.md`/`segments.json`/`.whisper-dispatch.json`=whisper만, meeting 내부 `.correction-checkpoint.json`=app summarize coordinator만, `transcript.md`/`summary.json`=app summarize publisher만, `meeting-tombstones/`=app lifecycle만. 남의 파일을 쓰지 않는다. Workspace/folder/placement는 중앙 registry metadata이며 `data/meetings/{id}/` 경로는 이동하지 않는다. 사용자 지정 제목은 `status.json.titleOverride`, 참석자는 `status.json.review`의 전용 app-api surface가 소유하며 summary editor가 `title`/`topicSlug`/`summary.participants`를 수정하지 않는다(ADR 0008, 0021, 0022, 0024).
- **영구 삭제 fence**: 회의 삭제는 `meeting-tombstones/{id}.json` durable rename을 logical commit으로 삼는다. Tombstone은 live directory보다 우선하며 모든 reader/writer/worker/scanner가 재생성을 fail-closed해야 한다. Malformed/unreadable/symlink marker는 임의 복구하지 말 것. Placement·deterministic trash·late producer orphan은 operation→artifact write lease 순서의 lazy sweep으로 정리하고 tombstone은 영구 보존한다(ADR 0015).
- **원자 finalize**: request body 전에 hidden `.finalize-{id}` intent를 durable create-exclusive하고, audio+initial status+immutable receipt를 staging에서 완성한 뒤 directory rename으로 publish한다. Published same-ID retry는 body를 읽거나 `audio.webm`을 덮지 않고 receipt 기반 probe/recovery를 수행한다. Placement pending/unavailable은 generic default reconcile에서 defer하며 post-publish remux·placement·dispatch 실패는 artifact commit을 되돌리지 않는다(ADR 0016).
- **편집 가능한 파생 pair 발행**: API/UI/adapter는 canonical `transcript.md`/`summary.json`을 직접 쓰지 않고 `summarizePublisher`만 두 파일을 함께 발행한다. 최초 생성만 불변 `raw.md` 교정 뒤 그 결과로 요약한다. 이후 `transcript_regenerate`는 `raw.md` 교정만 실행해 기존 summary를 보존하고, `summary_regenerate`는 현재 canonical transcript만 사용해 summary만 만든다. 수동 transcript/summary 저장도 반대편 artifact를 그대로 포함한 full-pair payload를 발행한다. Transcript 변경은 summary를 자동 생성하지 않고 `summaryOutdated`를 파생시키며, summary 수동 저장·재생성만 현재 transcript 기준 fresh 상태를 만든다. Adapter/202 또는 수동 발행 전 durable `summarizeAttempt`를 commit하고 `summary.json`을 completion marker로 마지막 발행한다. Pair consumer는 artifact read lease, publisher/delete/cleanup은 write lease를 사용하며 lock 순서 `meeting operation → artifact RW → status queue → library queue`를 거슬러 획득하지 말 것(ADR 0013, 0021).
- **교정 checkpoint·수동 재시도**: full/fast 교정 결과는 raw/glossary/provider/model/정규화 endpoint/prompt version/mode/chunk-plan identity가 일치할 때만 hidden local checkpoint로 재사용한다. 교정 성공 뒤 summary 실패·중단은 checkpoint를 보존하고, 사용자의 수동 재시도만 완료 교정/chunk를 재사용한다. canonical pair 성공 발행 뒤에만 best-effort 삭제하며 실패한 작업을 worker·재기동·network 복귀가 자동 재시작하지 않는다(ADR 0024).
- **Pipeline settings·Whisper model snapshot**: `data/pipeline-settings.json`은 `large-v3|large-v3-turbo`와 `full|fast`만 허용하는 원자 문서이며 missing/legacy는 quality-first `large-v3`+`full`이다. 저장은 download/load를 시작하지 않고 별도 prepare만 실행한다. 새 Whisper claim v2는 acceptance 시 fixed catalog model snapshot을 기록하며 같은 dispatch의 retry/resume는 설정 변경과 무관하게 그 snapshot을 쓴다. Prepare와 inference는 process-global execution fence 하나를 공유한다(ADR 0024).
- **자유 본문 요약 계약**: Generated summary는 기존 structured shape로 읽고, 수동 저장한 summary는 optional `body` 하나를 current editable truth로 쓴다. `body`가 있으면 `oneLine`/`purpose`와 모든 structured editable list/action item은 비어 있어야 하며 dual truth를 schema에서 거부한다. Body는 CRLF만 LF로 정규화하고 trim/heading parse/action-item 추론을 하지 않는다. Copy·Markdown/JSON·knowledge/search/chat evidence는 body를 사용하되 outdated summary에는 fresh semantic credit을 주지 않는다. 선택 tab의 local action bar는 tablist 직후, warning과 읽기 본문 또는 이를 교체한 single textarea 앞에 둔다(ADR 0022).
- **Library 직렬화**: `library.json`의 bootstrap/reconcile/mutation은 absolute canonical path 기준 process-global queue에서만 수행한다. Public mutation token은 `libraryId + revision`; durability pending 동안 후속 mutation은 fail-closed한다. 손상·상위 버전·I/O 오류 registry를 자동 bootstrap/sanitize하지 않는다.
- **Library 복구**: corrupt에서만 latest fingerprint를 요구하는 명시적 rebuild를 허용한다(ADR 0017). `libraryRecoveryPlanner`의 action을 같은 library queue 안에서 실행하고 original→private archive→new canonical 순서와 양쪽 namespace sync를 지킨다. Intent phase는 atomic replace하며 active marker를 truncate하지 않는다. Unsupported/I/O/conflict를 rebuild로 낮추지 말고 archive는 자동 삭제하지 않는다. 새 `libraryId` 수용 시 client generation epoch를 올려 old poll/mutation/page/dialog/source URL을 전부 폐기한다.
- **앱은 API 키를 저장하지 않는다**: 교정·요약은 백그라운드 워커가 사용자의 로컬 CLI(claude/codex)나 Ollama로 수행한다. 앱 코드에 Anthropic/OpenAI **API 키·유료 API 호출**을 넣지 말 것 — 로컬 CLI/모델만($0 원칙).
- **build-green**: `next build`가 시크릿/DB/env 없이 매번 통과해야 한다. `data/`를 읽는 라우트·페이지는 `export const dynamic='force-dynamic'` + `cache:'no-store'`; top-level `process.env` 접근 금지(핸들러 내 지연); whisper 클라이언트 지연 초기화; `data/`가 없어도 견디게; MediaRecorder/Web Audio 코드는 `"use client"`; 라우트는 Node 런타임(edge 금지).
- **127.0.0.1 바인딩**: whisper·로컬 서버는 로컬 인터페이스만. LAN 노출 금지.
- **로컬 요청 경계**: 모든 data API와 data-reading RSC는 params/body/fs/network/spawn보다 먼저 공통 guard를 통과한다. Raw Host는 exact `127.0.0.1|localhost`, unsafe method Origin은 request origin과 exact match, Fetch Metadata는 same-origin만 허용(API에서 `none` 금지). JSON은 exact content type + raw byte cap이며 public DTO/error는 path·job/dispatch ID·raw provider/fs output을 노출하지 않는다.
- **로컬 서비스 경계**: Ollama/Whisper egress는 explicit-port `http://127.0.0.1|localhost`만, redirect 금지. App→Whisper는 path 대신 `{meetingId,dispatchId}`만 보낸다. Whisper는 fixed data root에서 경로를 파생하고 service-owned durable claim으로 same-pair dedupe/resume한다.
- **전사 dispatch/completion**: app은 Whisper 호출 전 `status.transcriptionDispatch` proposed ID를 durable commit하고 retry/restart에서 같은 ID를 재사용한다. Whisper claim v2는 acceptance 시 effective model snapshot을 함께 고정하고 `segments.json` 먼저, `raw.md` 마지막 순서로 발행한다. Consumer는 matching service claim의 `raw_published` + `durable|best_effort` + audio/model identity를 확인하기 전 partial segments/raw를 읽지 말 것. Schema-v1 claim과 claim-less legacy raw는 호환한다(ADR 0014, 0024).
- **로컬 데이터 취급**: `data/`·`glossary.json`은 로컬 전용(gitignored, 커밋 금지) — 오디오·전사·요약·단어장(사람 이름 등 PII 포함 가능)은 디스크를 떠나지 않는다. 요약/내보내기물의 토큰·이메일·전화·URL **scrub은 지향 목표이나 현재 미구현**이며, 로컬 단일 사용자 hand-off 문서(`export`)엔 의도적으로 미적용한다(ADR 0007). 공유/업로드 표면이 생기면 그때 scrub을 강제한다.
- **Synthetic browser QA 경계**: 반복 가능 UI gate는 repository-owned Playwright command만 사용한다. `data/`·`glossary.json`·`.env*`·실제 benchmark/Whisper model/LLM·외부 network를 사용하지 않고 runner-owned 임시 snapshot과 empty data만 쓴다. 성공 screenshot/assertion/console manifest는 `test-results/` 또는 execute local journal에만 두며 Git에 커밋하지 않는다. Chrome DevTools MCP는 로그인 세션/정성 탐색이 꼭 필요할 때만 보조로 사용하고 자동 검증을 대체하지 않는다(ADR 0020, 0024).

### 일반 규칙
- 컴포넌트는 `src/components/`, 타입은 `src/types/`(또는 `src/domain/`), 유틸은 `src/lib/`, 외부 래퍼는 `src/services/`.
- 커밋 메시지는 conventional commits(feat:, fix:, docs:, refactor:, chore:).

## 개발 프로세스
- 모델 다운로드·긴 전사·`uv`/`npm install` 같은 무거운 작업은 **런타임에만**. 테스트·스모크는 tiny 모델/FAKE 스텁으로.
- Playwright/Chromium 갱신은 `package.json`의 exact version을 의도적으로 바꾼 뒤 browser 재설치 → doctor → 전체 E2E 순서로만 한다. 앱/Next 변경 때마다 Chrome DevTools MCP를 갱신하거나 별도 adapter를 보수하지 않는다.

## 명령어
```bash
npm run bootstrap   # doctor + npm ci + build + owned background app/Whisper + browser
npm run app:start   # 설치된 build를 owned background runtime으로 시작
npm run app:status  # ownership 확인 뒤 실제 URL과 app/Whisper 상태 조회
npm run app:stop    # ownership 확인된 supervisor만 종료
npm run benchmark:pipeline -- --meeting-id <exact-id> # 명시적으로 승인한 실제 회의의 격리 비교
npm run dev         # contributor용 foreground next dev + whisper
npm run build       # 프로덕션 빌드 (시크릿 없이 통과해야 함)
npm run lint        # ESLint
npm test            # vitest run (+ component test), watch 금지
npm run test:e2e:install # 최초 1회: 고정 Playwright 버전의 Chromium 설치
npm run test:e2e:doctor  # 읽기 전용: Node/package/browser 정합 확인
npm run test:e2e     # synthetic snapshot의 Chromium 3-viewport 회귀
npm run typecheck   # tsc --noEmit
npm run check:links # docs/context 마크다운 죽은 링크 0
```
