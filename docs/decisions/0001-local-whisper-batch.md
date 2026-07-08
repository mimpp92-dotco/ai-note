# 0001 — STT는 로컬 whisper 완전 배치(mlx large-v3), 실시간 자막 없음

- **날짜:** 2026-07-06
- **상태:** 채택됨

## 무엇을 결정했나
브라우저 실시간 전사(Web Speech/클라우드 스트리밍) 대신, 녹음 종료 후 로컬 whisper 배치 전사.

## 왜
품질 최우선(사용자 결정). Claude가 사후 교정하므로 녹음 중 자막이 필수 아님. 완전 로컬 = 프라이버시·$0. M2 Pro라 mlx large-v3가 빠름.

## 버린 대안
Web Speech / 클라우드 스트리밍 — 버그·구글 전송·비용 회피.

## 영향받는 곳
`whisper/server.py`, `src/services/whisperClient.ts`. 트레이드오프: 라이브 자막 없음(레벨미터·타이머로 대체).
