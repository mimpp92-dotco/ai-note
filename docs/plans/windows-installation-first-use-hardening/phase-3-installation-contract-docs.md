# Phase 3 — installation contract docs

검증된 Windows 설치 경계를 사람·에이전트·아키텍처 정본과 기존 ADR 0023에 같은 의미로 반영한다. 새로운 제품 기능이나 별도 결정 문서는 만들지 않는다.

## 읽어야 할 파일

README와 CONTRIBUTING의 설치/개발 안내, AGENTS와 Claude `/setup`의 URL-only agent 계약, scripts module guide, ARCHITECTURE의 bootstrap/runtime 경계, ADR 0023과 Phase 1·2의 최종 구현을 읽는다.

## 요구사항

- R1의 pre-mutation ownership 판정과 안전한 수동 restart 절차를 문서화한다.
- R2의 app·Whisper·AI NOTE root·library surface 성공 판정을 문서화한다.
- R3의 Windows environment/uv/ffmpeg 조치와 child-only cleanup 경계를 문서화한다.
- R4의 standalone Codex CLI, WindowsApps warning, shell/runtime restart와 optional provider 의미를 문서화한다.
- R5의 Windows synthetic CI 범위와 실제 bootstrap E2E가 아니라는 한계를 문서화한다.
- R6의 정본 목록과 기존 ADR 갱신을 완료한다.

## 허용 범위

승인된 일곱 문서만 수정한다. ADR 0023에는 Windows에서 확인된 후속 제약을 추가하되 기존 설치·first-run 결정과 연결을 보존한다.

## 금지 및 중단 조건

- 빈 콘텐츠의 원인을 하나로 확정하지 않는다.
- `codex --version` health가 인증 또는 실제 요약 성공을 보장한다고 쓰지 않는다.
- 자동 runtime stop, package install, login 또는 model download를 권장 흐름으로 만들지 않는다.
- 새 ADR, PRD, UI guide, changelog, screenshot을 추가·수정하지 않는다.
- 인접한 오래된 설명이나 스타일을 기회적으로 정리하지 않는다.

## 작업

1. README의 canonical bootstrap 설명에 existing-runtime 결과, four-surface readiness, Windows prerequisite/PATH restart 진단을 추가한다.
2. AGENTS와 Claude `/setup`은 install/update가 필요한 owned runtime을 자동 종료하지 않고 사용자 확인 뒤 stop/relaunch하도록 같은 순서를 사용한다.
3. ARCHITECTURE와 scripts module guide는 case-insensitive effective child env, exact uv resolution, terminal ffmpeg health, pre-ready handle cleanup과 library API owner 경계를 기록한다.
4. CONTRIBUTING은 Windows merge job의 target test/build/smoke 범위와 실제 provider·mic를 쓰지 않는 원칙을 설명한다.
5. ADR 0023에 후속 Windows 제약을 추가하고, auto restart를 채택하지 않은 이유와 root/library smoke의 최소 범위를 남긴다.
6. 문서 링크와 명령이 package scripts에 실제 존재하는지 확인한다.

## 테스트 (먼저 작성)

문서 전용 phase라 코드 테스트를 작성하지 않는다. 변경된 명령·경로·링크를 현재 repository와 대조하고 link checker로 검증한다.

## 문서 최신화

이 phase 자체가 정본 최신화 단계다. `docs/PRD.md`, `docs/UI_GUIDE.md`, decision index는 제품 기능·시각 계약·새 ADR이 없으므로 건드리지 않는다.

## 완료 게이트

```bash
npm run check:links
```
