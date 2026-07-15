# Phase 8 — final-gate-summarize-core-boundary-repair

최초 7개 phase 완료 뒤 full `npm test`가 검출한 producer-inventory 회귀만 복구한다. 최초 생성은 계속 app summarize coordinator가 소유하되 path/I/O 없는 `summarizeCore` 경계를 통해 transcript resolve와 summary normalization을 함께 수행해야 한다. transcript-only와 summary-only 재생성은 Phase 2에서 분리한 하위 함수를 그대로 사용한다.

## 읽어야 할 파일

- `AGENTS.md`
- `src/CLAUDE.md`
- `src/lib/summarize.ts`
- `src/lib/summarizeCore.ts`
- `scripts/__tests__/meeting-summarize.test.mjs`

## 요구사항

- R1: 최초 생성만 raw correction과 summary generation을 순차 실행한다.
- R4: transcript-only와 summary-only 재생성은 서로 독립적으로 유지한다.

## 허용 범위

- `src/lib/summarize.ts`

## 금지 및 중단 조건

- `data/**`
- `.env*`
- `glossary.json`
- `whisper/**`
- `src/lib/summarizeCore.ts`
- `src/lib/summarizePublisher.ts`
- `src/services/llm/**`
- `scripts/__tests__/meeting-summarize.test.mjs`
- 기존 producer-inventory 테스트를 수정하거나 약화해야 하면 중단한다.
- 최초 생성 외 `transcript_regenerate` 또는 `summary_regenerate` 동작을 바꿔야 하면 중단한다.
- correction 1회와 summary 최대 2회 호출 예산을 바꿔야 하면 중단한다.
- `summarizeCore` 또는 publisher에 I/O나 새 writer를 추가해야 하면 중단한다.
- 새 dependency, provider, API-key surface 또는 외부 network가 필요하면 중단한다.
- 허용 범위 밖 수정이 필요하면 중단한다.

## 작업

1. `src/lib/summarize.ts`의 최초 생성 분기에서 `summarizeCore`를 다시 production boundary로 사용한다.
2. correction adapter는 정확히 한 번만 호출하고 같은 correction/raw를 summary fallback 재시도에도 재사용한다.
3. summary adapter는 첫 시도와 schema fallback 재시도를 합쳐 최대 두 번만 호출한다.
4. `transcript_regenerate`는 `resolveTranscript`, `summary_regenerate`는 summary-only helper를 계속 직접 사용해 반대쪽 operation을 호출하지 않는다.
5. publication, durable attempt, knowledge-index refresh, failure classification은 변경하지 않는다.

## 테스트 (먼저 작성)

- 이 phase를 추가하기 전에 `npm test`에서 `final artifact producer inventory > keeps the command API-only and the app publisher as the sole production summarizeCore caller`가 RED로 관측됐다.
- 기존 producer-inventory 테스트가 수정 없이 GREEN이 되는지 확인한다.
- TypeScript 계약이 그대로인지 확인한다.

이미 존재하는 회귀 테스트가 정확한 RED를 제공하므로 테스트 파일을 형식적으로 수정하지 않는다. 구현 전 RED 로그는 execute journal의 직전 finalGate에 보존돼 있고, 이 phase는 target GREEN과 scope evidence를 새 attempt에 남긴다.

## 문서 최신화

- 정본 제품 문서는 Phase 7에서 완료됐다. 이 repair는 문서화된 동작을 바꾸지 않으므로 추가 제품 문서 수정은 없다.

## 완료 게이트

```bash
npm test -- scripts/__tests__/meeting-summarize.test.mjs
npm run typecheck
```
