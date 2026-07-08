# eval: /meeting-summarize 품질 루브릭

`raw.md`(원문 전사) → `transcript.md`(교정) + `summary.json`(구조화 요약)의 품질을 골드 케이스로 채점한다.

## 골드 케이스

| # | 입력 | 기대 출력 | 비고 |
|---|------|-----------|------|
| G1 | `fixtures/raw.md` | `fixtures/summary.happy.json` | 정상 경로 — 스키마 완전 충족 |
| G2 | (LLM 출력 파싱 실패 모의) | `fixtures/summary.fallback.json` | 폴백 — `src/lib/summarizeCore.ts`가 안전 축약 |

## 채점 (축별 0~5, pass = 평균 ≥ 4)

| 축 | 정의 | 측정 |
|----|------|------|
| 정확도 | 교정 전사가 원문 의미 보존 | 골드와 의미 일치 |
| 누락률 | 결정·액션아이템 누락 없음 | 기대 항목 recall |
| hallucination | 없는 결정/숫자 미생성 | 기대 외 항목 0 |
| 구조 충실도 | `src/domain/summarySchema.ts` 준수 | zod 파싱 통과 |

> **주의:** 루브릭 변경 시 이 파일과 `evals/agent-results.json`을 같은 PR에서 갱신(PR 템플릿 체크리스트).
