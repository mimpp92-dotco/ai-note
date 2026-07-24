# 0023 — 안전한 설치와 first-run UX

- **날짜:** 2026-07-25
- **상태:** 채택됨

## 무엇을 결정했나

저장소 URL만 받은 agent는 사용자가 target을 지정하지 않으면 현재 directory 자체에 설치하지 않는다. 다른 Git repository 안에서는 그 root의 sibling `ai-note`, 그 밖에서는 cwd 아래 새 `ai-note`를 기본으로 삼고, 충돌하면 기존 내용을 재사용·덮어쓰기·pull하지 않고 첫 free deterministic suffix(`ai-note-2`, `ai-note-3`, …)를 선택한다. 명시 target이 non-empty이거나 다른 origin이면 exact absolute path를 보고하고 중단한다. Clone/install은 target 안에서만 변경하며 ancestor `.git`·`.claude`·`.harness`, global Git config, 다른 project/package/process를 건드리지 않는다. 새 OS 권한이나 provider login에만 승인을 요청하고 handoff에는 absolute path, branch/revision, actual URL을 포함한다. 이 계약은 agent가 repository의 공개 문서를 읽은 뒤부터 적용되며 pre-clone host policy까지 repository가 보장하지 않는다.

Clone 뒤 end-user 정본은 `node scripts/bootstrap.mjs --launch`다. Dependency-free doctor → `HUSKY=0 npm ci` → secret 없는 build → repository-owned background supervisor 순서로 실행한다. App은 `127.0.0.1:3000`, Whisper는 `127.0.0.1:8123`부터 bounded 후보를 선택하고 bind race면 다음 후보로 이동한다. 기존 listener에 연결하거나 종료하지 않으며 선택 port는 child env에만 넣고 `.env.local`을 쓰지 않는다. App과 same-origin Whisper health가 모두 ready인 뒤 `http://localhost:<actual-port>` 하나를 출력하고 OS opener에 argv로 전달한다. Headless/opener failure는 server 성공을 유지하며 exact URL과 agent browser fallback을 안내한다.

Runtime ownership은 gitignored `.ai-note-runtime/`의 restricted state/heartbeat/log로 증명한다. Metadata에는 root/token/PID/port/time만 두고 environment나 credential을 기록하지 않는다. `app:status`와 `app:stop`은 root, token, fresh heartbeat, live supervisor가 모두 일치할 때만 동작하며 stale/unverifiable PID에 signal하지 않는다. `npm run dev`는 contributor foreground lifecycle로 남긴다. Playwright/Chrome extension/MCP는 product runtime dependency가 아니다.

First-use는 요약 모델 준비를 recorder 앞에서 비차단으로 안내한다. **AI 요약 설정**과 같은 화면의 **요약 없이 회의 녹음** focus action을 제공하며 녹음·로컬 전사를 막지 않는다. Settings는 요약 모델을 optional profile보다 먼저 둔다. Claude는 CLI default/`sonnet|opus|haiku`/custom, Codex는 CLI default/custom, Ollama는 loopback `/api/tags`의 installed model/refresh/custom을 제공한다. Unknown stored string과 provider별 draft를 보존하고 auto pull/remote catalog/API key를 추가하지 않는다. 저장 직후 persisted health를 자동 검사하되 CLI success는 binary 감지일 뿐 인증·생성 성공 보장이 아니고 Ollama success는 선택 model의 loopback 연결 확인이다.

전사 실패는 list/detail/finalize result에 지속 표시하고 **전사 다시 시도**가 exact meeting ID로 기존 `POST /api/transcribe`를 호출한다. Accepted/already-running race 뒤 server state를 갱신하고 single in-flight polling, safe error, polite status, focus return을 유지한다. 완료 meeting은 explicit query가 없고 usable summary가 있으면 summary tab을 기본으로 연다.

## 왜

기존 안내는 foreground `npm run dev`, fixed `localhost:3000`, 수동 `npm install`을 end-user 성공 경로로 섞었다. 이 방식은 port collision에서 다른 process와 구분하기 어렵고, agent가 어느 directory를 수정했는지와 long-lived process ownership을 handoff하기 어렵다. Repository-owned bootstrap과 target policy를 함께 두면 clone 경계, dependency/build, 실제 URL, health와 shutdown을 한 흐름으로 검증하면서 기존 project와 global state를 보호할 수 있다.

첫 실행에서는 요약 model을 준비하지 않아 background summary가 실패하기 쉽지만 이를 recording gate로 만들면 local transcription이라는 독립 가치도 잃는다. Provider별로 실제 지원 범위만 보여 주고 persisted health의 의미를 좁히면 hard-coded catalog와 false-green 인증 문구 없이 준비를 돕는다. 전사 retry도 finalize probe가 아니라 이미 durable identity/recovery를 소유한 transcribe route를 재사용해야 실제 실패를 복구할 수 있다.

## 버린 대안

- Current directory에 바로 clone하거나 기존 `ai-note`를 reuse/pull — ancestor repository와 사용자 파일을 오염하거나 예상 밖 history를 바꿀 수 있어 기각.
- Fixed `localhost:3000`/`8123` 또는 기존 listener 재사용 — port collision과 service identity를 구분하지 못해 기각.
- Bootstrap이 package manager, `sudo`, provider login, `ollama pull`을 자동 수행 — 권한·비용·network 선택을 숨겨 기각.
- `.env.local` 또는 global PID registry에 selected ports/runtime을 기록 — 사용자 설정을 덮거나 repository ownership을 흐려 기각.
- `npm run dev`를 detached end-user runtime으로 재사용 — foreground contributor lifecycle과 safe status/stop ownership을 제공하지 못해 기각.
- Claude/Codex model catalog를 remote/experimental command로 discovery — version drift와 새 provider surface를 만들어 기각.
- 요약 모델을 recording prerequisite로 강제하는 onboarding route/modal — 녹음·로컬 전사를 불필요하게 막아 기각.
- Transcription retry를 finalize probe나 fresh dispatch endpoint로 구현 — 실제 transcribe 재호출과 ADR 0014의 durable identity를 우회해 기각.
- Chrome DevTools MCP를 browser open 또는 반복 QA의 필수 조건으로 사용 — local install/runtime과 deterministic gate를 external session 상태에 묶어 기각.

## 영향받는 곳

- 공개 설치/운영 계약: `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.claude/commands/setup.md`, `package.json`, `scripts/setup.mjs`, `scripts/bootstrap.mjs`, `.ai-note-runtime/`.
- First-use/model UI와 local discovery: `HomeClient`, `Recorder`, Settings page/`SettingsForm`, `/api/settings/llm/models`, Ollama adapter.
- 전사 복구/default detail: meeting list/detail, `RecorderFinalizeResultView`, 기존 `/api/transcribe`, meeting page tab resolver.
- 반복 검증: repository-owned synthetic Playwright first-run scenario와 `desktop-1440`, `mobile-390`, `mobile-320` evidence.

Ingress·loopback egress/DTO는 ADR [0012](0012-local-ingress-and-fixed-id-service-boundary.md), durable transcription identity와 raw-last completion은 ADR [0014](0014-durable-transcription-dispatch.md), finalize publication/probe는 ADR [0016](0016-atomic-finalize-directory-publication.md), deterministic browser evidence와 Chrome DevTools MCP 경계는 ADR [0020](0020-deterministic-synthetic-browser-verification.md)을 그대로 따른다. 이 결정은 네 ADR을 재작성하거나 대체하지 않는다.
