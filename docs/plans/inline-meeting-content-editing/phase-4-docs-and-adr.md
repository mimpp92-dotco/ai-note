# Phase 4 — docs and ADR

검증된 구현을 사람·에이전트 정본에 반영하고, 구조화 생성 결과 위에 수동 plain-text body mode를 추가한 이유와 tradeoff를 신규 ADR로 기록한다.

## 읽어야 할 파일

README, AGENTS, src 지침, PRD, ARCHITECTURE, UI_GUIDE, ADR 목록과 ADR 0021을 읽고 실제 summary schema/body helper, detail UI, knowledge/search 구현을 대조한다.

## 요구사항

- R1~R3의 action bar 위치와 본문 교체형 single-textarea UX를 문서화한다.
- R4의 optional body, structured clearing, regeneration, export/index/search 의미를 문서화한다.
- R5의 pair writer, freshness, probe, navigation guard와 title/participants ownership을 유지한다.
- R6의 신규 ADR과 browser 검증 기준을 준비한다.
- R7의 입력 한도, confirmed/draft 안내, tab 문맥과 오류별 안전한 recovery matrix를 문서화한다.

## 허용 범위

제품 README, root/src agent instruction, PRD·ARCHITECTURE·UI_GUIDE, ADR index와 신규 ADR 0022만 수정한다. Historical ADR 0021은 기록으로 보존한다.

## 금지 및 중단 조건

- 검증되지 않은 동작이나 미래 확장을 정본으로 선언하지 않는다.
- ADR 0021을 삭제·재작성하지 않는다.
- Pair publisher, title writer, participants writer가 바뀐 것처럼 서술하지 않는다.
- 문서 수정 때문에 코드·테스트 범위를 열지 않는다.

## 작업

1. README와 PRD의 per-field summary editor 설명을 single freeform body로 교체한다.
2. AGENTS와 src/CLAUDE에 optional body, dual-truth rejection, action bar 위치, body-mode consumer/search 의미와 금지사항을 짧은 실행 지침으로 반영한다.
3. ARCHITECTURE의 exact structured-to-body projection, summary schema invariant, manual API/resource, 512 KiB serialized request cap, publisher payload, knowledge-card/corpus/search, Markdown/JSON consumer와 typed failure 계약을 실제 field와 normalization에 맞춘다.
4. UI_GUIDE의 footer 용어를 tab-local action bar로 바꾸고 tablist → action → warning → body 순서, mutually exclusive editor, confirmed-copy 안내, 수정 중 tab label, single textarea validation, error/recovery, discard 안전 초점과 320px 기준을 기록한다.
5. ADR 0022는 다음을 명시한다.
   - generated structured summary와 manual freeform body의 두 mode
   - body mode에서 structured editable field를 비워 dual truth를 막는 결정
   - title/topicSlug/participants ownership 보존
   - body를 copy/export/index/search evidence에 사용하는 결정
   - action item parsing을 하지 않는 tradeoff와 regeneration recovery
   - confirmed 저장본과 draft의 action 의미, body request cap과 typed recovery matrix
   - ADR 0021 중 footer/structured form 부분만 대체하고 durable pair/freshness/probe/guard는 유지
6. ADR 목록에 0022와 부분 대체 관계를 추가한다.
7. Browser 기준은 repository-owned Playwright, 세 viewport, synthetic-only이며 실제 결과를 미리 성공으로 쓰지 않는다.

## 테스트 (먼저 작성)

문서 전용 phase이므로 새 코드 테스트를 만들지 않는다. `npm run check:links`가 신규 ADR과 모든 갱신 링크를 검증한다. 문서와 구현 field/copy가 다르면 문서를 추측해 맞추지 않고 중단한다.

## 문서 최신화

이 phase 자체가 문서 최신화 checkpoint다. Machine path/command 목록은 `plan.json`이 정본이고 이 문서는 업데이트 의도와 수용 기준을 설명한다.

## 완료 게이트

```bash
npm run check:links
```
