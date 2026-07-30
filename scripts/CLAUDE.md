# scripts — 유틸리티 스크립트

상위 진입점: [../AGENTS.md](../AGENTS.md) · 전체 계약: [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)

## 목적 Purpose / Owns
저장소 유지보수용 Node 스크립트를 소유한다.

- `scripts/check-links.mjs` — 마크다운 링크 무결성 체커(CI 게이트). 저장소 내 모든 `.md`의 상대 링크가 실재 파일/디렉토리를 가리키는지 검사, 깨진 링크가 하나라도 있으면 exit 1.
- `scripts/setup.mjs` — 설치 닥터(`npm run setup`). Node·`uv`·`ffmpeg`·요약기·`.env.local`을 점검해 ✓/⚠/✗ 안내. **읽기 전용·무의존**(node: 빌트인 + 글로벌 fetch만 — `npm install` 전에도 실행). 바이너리는 실행하지 않고 PATH 존재만 확인(인증 프롬프트 hang 회피). Windows는 `Path`/`PATH`·`PATHEXT`를 case-insensitive effective child environment로 정규화하고 값을 합치지 않으며, 첫 Codex 후보가 명확한 WindowsApps desktop package일 때만 독립 CLI 확인 warning을 낸다. Codex는 optional이므로 이 warning은 blocker가 아니며, 독립 CLI 설치 뒤에는 새 PowerShell과 녹음 확인 후 owned runtime stop/relaunch가 필요하다. 순수 함수는 export하고 부수효과는 CLI 가드 뒤에서만 → `scripts/__tests__/setup.test.mjs`가 순수 함수를 주입식 의존으로 검증. CI/`postinstall`에 연결하지 않는다.
- `scripts/bootstrap.mjs` — end-user 정본(`--launch`, `start|status|stop`). `--launch`는 install/build mutation보다 repository-local runtime ownership을 먼저 판정한다. Absent만 doctor → `HUSKY=0 npm ci` → build → owned background supervisor를 수행하고, owned는 stop/restart/install/build 없이 기존 runtime을 검증·개방해 update 미적용을 알린다. Stale/unsafe/unverifiable은 signal·mutation 없이 중단한다. App은 3000, Whisper는 8123부터 각각 20개 loopback 후보만 사용하고 bind race면 다음 후보로 이동한다. 기존 port process에 연결하거나 종료하지 않으며 선택 포트는 child env에만 넣고 `.env.local`을 쓰지 않는다.
  - `.ai-note-runtime/`의 state/heartbeat/log만 만들며 directory `0700`, file `0600`을 유지한다. State에는 repository root, ownership token, PID/port/time만 기록하고 inherited environment·credential은 기록하지 않는다. Status/stop은 root+token+fresh heartbeat+live supervisor가 모두 맞을 때만 동작하며 stale/unsafe PID에 signal을 보내지 않는다.
  - App health, same-origin `/api/whisper/health`, AI NOTE root HTML, existing `/api/library` public mode를 `canonicalAppUrl()`의 `http://localhost:<actual-port>` authority로 bounded probe하고 네 surface 성공 뒤에만 URL을 출력한다. Library `ready|degraded_last_good|degraded_fallback`만 지원하며 repair/write는 하지 않는다. App/Whisper child bind와 direct service URL은 계속 explicit-port `127.0.0.1`이다.
  - Doctor와 spawn은 같은 normalized environment와 exact resolved `uv.exe`를 공유하고 argv+`shell:false`로 공백 경로를 보존한다. Whisper의 명확한 ffmpeg-missing health는 generic timeout 전에 static 설치/`--launch` 재실행 조치로 끝낸다. Ready 전 signal/error는 이번 시도의 child handle만 idempotent cleanup한다.
  - Import는 side-effect free다. Unit test는 command/process/network/port/browser/time/fs 경계를 주입한 fake와 임시 directory만 사용하고 `npm ci`, build, long-lived server, browser opener, external network, model download를 실행하지 않는다. Browser URL은 shell string이 아니라 argv로 넘기며 headless/opener failure는 exact URL fallback으로 성공을 유지한다. 기존 owned build를 갱신하려면 사용자가 녹음이 없는지 확인하고 `app:stop` 후 같은 `--launch`를 다시 실행한다.
- `scripts/meeting-pipeline-benchmark.mjs` — 사용자가 exact meeting ID를 명시하고 실제 audio/transcript/glossary/provider 사용을 승인했을 때만 실행하는 격리 benchmark owner. Source meeting은 read-only로 열고 `.ai-note-runtime/benchmarks/<run-id>/` mode-0700 snapshot만 writer target으로 사용한다. `large-v3|large-v3-turbo`, `full|fast` output/hash/stage time과 human review template를 남기되 canonical publisher/status/library/dispatch를 호출하지 않고 terminal에는 safe status/run directory만 쓴다.
- `scripts/e2e-doctor.mjs` — Node baseline, exact `@playwright/test` package, matching Chromium executable만 읽기 전용 점검한다. 설치·다운로드·파일 수정·network를 수행하지 않는다.
- `scripts/run-e2e.mjs` — loopback port와 OS temp snapshot의 최상위 owner. scrubbed Playwright env로 local CLI를 실행하고 성공/실패/정상 signal 뒤 snapshot을 반드시 제거한다.
- `scripts/e2e-server.mjs` — allowlist source를 runner-owned empty snapshot에 복사하고 empty `data/`, synthetic `HOME`, disabled worker/disconnected Whisper로 Next를 `127.0.0.1`에 띄운다. 실제 `data/`·glossary·env·로컬 서비스에 접근 금지.
- `scripts/e2e-harness.mjs` — 위 경계의 순수/검증 helper와 allowlist 정본. 변경 시 `scripts/__tests__/e2e-harness.test.mjs`를 먼저 갱신한다.

## 자주 하는 변경 Common changes (patterns)
- **링크 검사 규칙 변경**: `scripts/check-links.mjs`의 `IGNORE_DIRS`/`LINK_RE`만 수정. 생성물·의존성 디렉토리(`node_modules`·`.next`·`data` 등)는 스캔에서 제외한다.
- **Browser QA 변경**: product scenario는 `e2e/**/*.spec.ts`, 공통 console/network/screenshot 수집은 `e2e/support/synthetic-test.ts`, execute manifest shape는 `e2e/support/evidence-reporter.ts`가 소유한다. Chrome DevTools MCP 호출이나 실제 사용자 data/service 의존을 추가하지 않는다.
- **Benchmark 변경**: exact safe ID, no-follow bounded source read, original-root write 금지, private output과 child cleanup을 유지한다. Unit/Playwright/final gate는 synthetic placeholder와 injected filesystem/process/clock만 사용하며 real data/provider/model/network를 절대 실행하지 않는다. Human review가 비어 있으면 recommendation은 항상 `undecided`다.

## 의존 Dependencies (cross-module)
- setup/bootstrap/link/harness orchestration은 Node stdlib, browser doctor/runner는 pinned `@playwright/test` devDependency를 사용한다. 저장소 루트에서 실행한다.

```bash
npm run bootstrap       # end-user install/build/background launch/browser
npm run app:start       # installed build background start
npm run app:status      # owned runtime status + actual URL
npm run app:stop        # owned supervisor stop
npm run benchmark:pipeline -- --meeting-id <exact-id> # 명시 승인한 실제 회의만
npm run check:links     # 마크다운 죽은 링크 0 검사
npm run test:e2e:doctor # Playwright/Chromium 준비 상태(읽기 전용)
npm run test:e2e        # isolated synthetic Chromium regression
```
