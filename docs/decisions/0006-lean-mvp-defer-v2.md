# 0006 — 린 MVP-0, 견고성 일부 v2 연기

- **날짜:** 2026-07-06
- **상태:** 채택됨

## 무엇을 결정했나
chunk-append 크래시복구·전체 FSM+워치독·map-reduce·auto-queue·상세 녹음 폴리시·Playwright는 v2로 연기.

## 왜
참조 앱조차 메모리 버퍼+stop 저장만 함. 1인 툴에 멀티유저급 견고성은 과함. first-pass 성공률↑.

## 버린 대안
MVP-0에 풀 견고성 — 30분 step 예산 초과·과설계.

## 영향받는 곳
`src/components/useRecorder.ts`, `src/lib/recorder.ts`. 트레이드오프: 긴 녹음 크래시 시 유실 가능(`beforeunload`로 80% 방어), 긴 회의는 잘림 경고.
