# src — Next.js 앱 (UI · API · 핵심 계약)

상위 진입점: [../AGENTS.md](../AGENTS.md) · 전체 계약: [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)

## 목적 Purpose / Owns
녹음 UI, HTTP API 라우트, 그리고 프로젝트의 순수 도메인 계약(타입·FSM·zod 스키마)을 소유한다. 교정·요약은 백그라운드 워커가 사용자의 로컬 CLI(claude/codex)·Ollama로 수행한다($0 — API 키 미저장).

- `src/app/` — 페이지(`src/app/page.tsx`, `src/app/meetings/[id]/page.tsx`) + API 라우트 핸들러(`src/app/api/meetings/route.ts`, `src/app/api/transcribe/route.ts`, `src/app/api/whisper/health/route.ts` 등, 모두 Node 런타임).
- `src/components/` — `Recorder`/`useRecorder`(MediaRecorder), `HomeClient`, `MeetingDetailView` 등.
- `src/domain/` — 무의존 타입/FSM/스키마(`src/domain/meeting.ts`, `src/domain/summarySchema.ts`).
- `src/lib/` — 유틸(`src/lib/atomicWrite.ts`, `src/lib/status.ts`, `src/lib/paths.ts`, `src/lib/summarizeCore.ts`).
- `src/services/` — 외부 래퍼(`src/services/whisperClient.ts`).

## 자주 하는 변경 Common changes (patterns)
- **새 API 라우트**: `src/app/api/**/route.ts`에 추가. **주의(build-green)**: `data/`를 읽으면 `export const dynamic='force-dynamic'` + fetch는 `cache:'no-store'`; top-level `process.env` 접근 금지(핸들러 내 지연); edge 런타임 금지.
- **상태 전이**: `status.json`은 **app-api만** 쓴다(단일 writer). FSM은 `src/domain/meeting.ts` 참조.
- **아티팩트 쓰기**: 항상 `src/lib/atomicWrite.ts`(temp→fsync→rename) 경유. 원본(`audio.webm`/`raw.md`)은 수정 금지.
- **요약 파싱**: 결정론적 후처리는 `src/lib/summarizeCore.ts`(LLM 호출 없음).

## 의존 Dependencies (cross-module)
- `whisper`(HTTP `127.0.0.1:8123`)를 `src/services/whisperClient.ts`로 호출 — **지연 초기화**(build-green).
- `data/meetings/{id}/` 파일 존재로 상태 파생(DB 없음).
- 스캐폴드 규약은 상위 [../AGENTS.md](../AGENTS.md)의 CRITICAL 참조.

```bash
npm run dev    # next dev + whisper 동시 기동
npm test       # vitest (co-located __tests__)
npm run build  # 시크릿/DB 없이 통과해야 함
```
