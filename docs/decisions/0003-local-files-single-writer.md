# 0003 — 로컬 파일 저장(DB 없음) + 단일 writer 파일 소유권

- **날짜:** 2026-07-06
- **상태:** 채택됨

## 무엇을 결정했나
`data/meetings/{id}/`에 artifact를 안정적으로 저장한다. app-api=`status.json`, whisper=`raw.md`/`segments.json`, 요약 워커=`transcript.md`/`summary.json`. Workspace/folder/placement는 app의 library repository가 소유하는 중앙 `data/library.json`에만 저장하며 meeting directory를 물리적으로 이동하지 않는다.

## 왜
DB 없이도 파일별 writer가 하나면 artifact 소유권 충돌을 피할 수 있다. 다만 한 사용자 앱에도 HTTP·poller·background task가 겹치므로 중앙 registry는 absolute-path process queue와 `libraryId+revision` token으로 lost update를 막는다. app은 원본 writer 파일을 수정하지 않고 파일 존재로 lifecycle을 파생한다.

## 버린 대안
DB / multi-process shared-disk coordination — 로컬 단일 Next Node process 범위를 넘어가므로 비목표.

## 영향받는 곳
`src/lib/paths.ts`, `src/lib/status.ts`, `src/lib/library.ts`, `src/lib/atomicWrite.ts`. 내구 commit 의미와 registry queue는 ADR 0011이 구체화한다.
