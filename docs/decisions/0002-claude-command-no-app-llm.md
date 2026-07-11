# 0002 — 교정·요약은 로컬로, 앱은 외부 유료 API 미호출

- **날짜:** 2026-07-06
- **상태:** 채택됨 (팀 모드에서 갱신 — 아래 "갱신" 참조)

## 무엇을 결정했나
앱은 녹음/저장/열람만. 교정·요약은 별도 수동 커맨드(`/meeting-summarize`)가 담당한다.

## 왜
구독/로컬 모델로 처리 → API 비용 $0·키 불필요. 요약을 사람이 검토(human-in-the-loop)해 오류를 거른다.

## 버린 대안
앱 내 유료 API 호출 자동화 — 비용·키 관리·무검토 위험. 자동화는 후속.

## 영향받는 곳
`.claude/commands/meeting-summarize.md`, `src/lib/summarizeCore.ts`.

## 갱신 (팀 모드)
원래는 "앱이 LLM을 직접 호출하지 않고, 별도 수동 커맨드가 요약한다"였다. 이제 앱이 백그라운드 워커로 사용자의 로컬 CLI(`claude`/`codex`)나 로컬 Ollama를 통해 직접 요약한다. 핵심 불변식은 유지된다: 여전히 $0(구독/로컬 모델)이며 **API 키를 저장하지 않는다**.

Phase 7 갱신: API-only command·워커는 트리거이자 LLM producer일 뿐 canonical artifact writer가 아니다. 검증된 payload를 app summarize publisher에 넘겨 durable pair로 발행한다(ADR [0013](0013-durable-summarize-pair-publication.md)).
