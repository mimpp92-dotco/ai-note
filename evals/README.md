# evals/ — AI 기능 품질 채점 (Agent Performance Outcomes)

이 프로젝트의 유일한 AI 기능은 `/meeting-summarize`(원문 전사 → 교정 + 구조화 요약)다. 여기서 **회귀 없이 잘 작동하는지 정량 측정**한다. 프롬프트를 고치기 전에 이 채점표부터 본다 — "감"이 아니라 pass-rate로.

> **주의(Note):** 앱 코드는 LLM을 호출하지 않으므로(§AGENTS.md $0 원칙), eval은 Claude Code 커맨드 실행 결과를 골드 케이스와 대조한다. 결정론적 후처리는 `src/lib/summarizeCore.ts`.

## 무엇을 재나

- `evals/meeting-summarize.eval.md` — 품질 루브릭(축별 0~5) + 골드 케이스
- `evals/agent-results.json` — 실행 결과(케이스별 pass/fail + 점수)
- 골드 입력 시드: `fixtures/raw.md`, 기대 출력: `fixtures/summary.happy.json` · `fixtures/summary.fallback.json`

## 실행

```bash
npm run eval    # TODO(런너 미구현): 골드 케이스 → 채점 → agent-results.json 갱신
```

## 루브릭 축

1. 정확도 — 교정 전사가 원문 의미를 보존하는가
2. 누락률 — 결정·액션아이템을 빠뜨리지 않는가
3. hallucination — 없는 결정/숫자를 지어내지 않는가
4. 구조 충실도 — `src/domain/summarySchema.ts` 스키마를 지키는가
