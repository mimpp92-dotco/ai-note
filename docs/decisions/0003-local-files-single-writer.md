# 0003 — 로컬 파일 저장(DB 없음) + 단일 writer 파일 소유권

- **날짜:** 2026-07-06
- **상태:** 채택됨

## 무엇을 결정했나
`data/meetings/{id}/`에 파일 저장. app-api=`status.json`, whisper=`raw.md`/`segments.json`, 요약 워커=`transcript.md`/`summary.json`.

## 왜
1인/1탭이라 동시성 없음 → DB·sole-writer 엔드포인트·낙관적 동시성 불필요. app은 파일 존재로 상태 파생.

## 버린 대안
DB / 멀티유저 동시성 제어 — 1인 툴에 과함(비목표).

## 영향받는 곳
`src/lib/paths.ts`, `src/lib/status.ts`, `src/lib/atomicWrite.ts`. 트레이드오프: 원자적 쓰기로 부분쓰기만 방어.
