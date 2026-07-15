# 0020 — 결정적 synthetic browser 검증

- **날짜:** 2026-07-15
- **상태:** 채택됨

## 무엇을 결정했나

반복 가능한 browser gate는 `ai-note`가 직접 소유한 exact-version `@playwright/test`와 Chromium command(`npm run test:e2e`)로 수행한다. Desktop 1440, mobile 390, mobile 320에서 web-first assertion을 실행하고 성공 screenshot·assertion·console evidence를 command가 생성한다. Chrome DevTools MCP는 사용자의 기존 Chrome 로그인/탭/extension 상태가 필요한 정성 탐색에만 선택적으로 사용하며 필수 preflight나 완료 gate로 사용하지 않는다.

Browser test는 실제 앱 작업 트리에서 서버를 띄우지 않는다. 상위 runner가 OS temp에 매 실행 새 snapshot을 만들고, allowlist된 product source·public asset·build metadata와 empty `data/`만 넣는다. Background worker와 실제 Whisper/LLM/CLI는 비활성화하고, child/Playwright 환경에서 API key·provider·glossary 경로 등 무관한 env를 제거한다. 서버는 `127.0.0.1`에만 bind하고 browser는 Next 15 Route Handler가 쓰는 동등한 loopback authority인 `localhost`로 접속한다. 외부 browser request나 console error가 하나라도 있으면 실패한다.

Evidence reporter는 synthetic provenance, required viewport, screenshot/assertion/console file의 SHA-256과 byte size를 `manifest.json`에 기록한다. 일반 실행 산출물은 gitignored `test-results/`에, `/execute` 실행에서는 runner가 주입한 Git local journal에만 둔다. Screenshot/report를 plan 우회용 Git 경로에 커밋하지 않는다.

## 왜

Chrome DevTools MCP의 enabled/connected 상태와 모델 CLI의 MCP 관리 명령은 제품 회귀의 결정적 입력이 아니다. CLI/extension/Chrome session 업데이트에 따라 capability 탐지가 달라지면 같은 코드가 테스트 시점마다 preflight에서 멈추고, 모델이 작성한 screenshot 설명을 완료 증거로 신뢰하게 된다. Repository-owned Playwright command는 dependency, browser revision, selector, fixture, viewport와 결과 형식을 코드/lockfile/CI에서 함께 고정할 수 있다.

또한 이 앱의 실제 `data/`에는 녹음·전사·요약·사람 이름 같은 로컬 정보가 있다. 시각 검증에 그 데이터가 필요하지 않으므로 empty synthetic library가 최소이자 안전한 정본이다. App server 환경까지 격리해야 우연히 실행 중인 로컬 Whisper/Ollama/CLI에 연결되는 false green을 막을 수 있다.

## 버린 대안

- **모든 browser phase를 Chrome DevTools MCP로 실행**: 기존 Chrome 상태가 필요한 탐색에는 유용하지만 설치/연결/session 상태가 반복 gate의 성공 조건이 되고 artifact 생성도 모델 판단에 의존한다.
- **Playwright가 실제 `data/`를 읽는 기존 dev server 재사용**: 빠르지만 사용자 데이터·설정·로컬 서비스 상태가 결과와 screenshot에 섞이고 병렬/재시작 재현성이 없다.
- **매 실행 전체 `node_modules`를 snapshot에 복사**: dependency를 더 강하게 물리 격리하지만 현재 약 471MB를 매번 복사해야 한다. Source/data/env는 temp snapshot으로 격리하고 검증된 실제 dependency directory만 연결하는 편이 비용 대비 명확하다.
- **pixel baseline을 필수 gate로 사용**: 플랫폼/font rendering 차이의 노이즈가 크다. 현재는 semantic/web-first assertion과 성공 screenshot evidence를 정본으로 삼고 pixel diff는 도입하지 않는다.

## 영향받는 곳

- Dependency/command: `package.json`, `package-lock.json`, `playwright.config.ts`.
- Isolation/doctor: `scripts/e2e-harness.mjs`, `scripts/e2e-server.mjs`, `scripts/run-e2e.mjs`, `scripts/e2e-doctor.mjs`.
- Scenario/evidence: `e2e/**/*.spec.ts`, `e2e/support/synthetic-test.ts`, `e2e/support/evidence-reporter.ts`.
- CI는 별도 Node 22 job에서 pinned Chromium을 설치한 뒤 doctor와 E2E를 실행한다. 기존 Node 20 lint/typecheck/unit/build job과 `npm test`에는 browser download나 E2E를 섞지 않는다.
- Browser 갱신은 앱 변경 때마다 하지 않는다. `@playwright/test` exact version을 의도적으로 올리고 lockfile 갱신 → `npm run test:e2e:install` → doctor → 전체 E2E 순서로 검증할 때만 matching Chromium revision이 바뀐다. Chrome DevTools MCP 업데이트를 이 경로에서 보수할 adapter는 없다.
