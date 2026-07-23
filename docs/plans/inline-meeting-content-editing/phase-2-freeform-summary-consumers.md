# Phase 2 — freeform summary consumers

Canonical optional body를 화면 밖 consumer에서도 동일한 현재 요약 내용으로 사용한다. 수동 body와 비워진 structured field 사이에 숨은 fallback을 만들지 않으며 기존 body 없는 index artifact는 계속 읽는다.

## 읽어야 할 파일

요약 schema/body helper, ADR 0018의 파생 index·검색·chat evidence 경계, knowledge schema/builder/repository, summary Markdown/export, meeting search와 chat tool, 관련 domain·repository·consumer/API 테스트를 읽는다.

## 요구사항

- R4의 copy, export, knowledge card, 일반 검색과 evidence 소비를 자유 body에 맞춘다.
- R5의 outdated summary 차단, live metadata와 derived index non-rollback 불변식을 유지한다.

## 허용 범위

Knowledge v1의 additive optional projection, summary Markdown, knowledge builder, deterministic meeting search와 필요할 때 bounded chat projection 및 관련 테스트만 수정한다. Artifact reader, repository durability, search API route와 export route의 안전 경계는 그대로 둔다.

## 금지 및 중단 조건

- 기존 body 없는 knowledge-card/corpus-map v1을 corrupt로 만들지 않는다.
- 자유 본문에서 action item이나 참석자를 추론하지 않는다.
- outdated summary에 검색·chat citation credit을 주지 않는다.
- 일반 검색이 transcript 전문 또는 모델 호출을 사용하게 하지 않는다.
- 사용자 data, 외부 network, provider 또는 새 dependency를 사용하지 않는다.

## 작업

1. Knowledge card content와 bounded corpus projection에 optional body를 additive하게 수용해 old v1 bytes를 계속 parse한다.
2. Manual body summary의 card는 body를 담고 structured semantic field와 actionItems는 빈 상태를 유지한다. Mentioned people도 빈 action owner에서 만들어 내지 않는다.
3. Corpus body는 기존 bounded artifact 원칙에 맞는 명시적 character cap을 두되 full card는 current manual body를 검색할 수 있게 한다.
4. 일반 검색에 `회의록 본문` field/label과 고정 weight를 추가한다. Body query가 deterministic excerpt를 반환하고 title/live metadata ranking 경계를 바꾸지 않는다.
5. `hasActionItem`은 canonical body text를 parse하지 않고 empty structured actionItems를 그대로 사용한다.
6. Summary copy와 combined Markdown은 effective meeting title·freshness warning·current review participants 경계를 유지하면서 manual body를 그대로 포함하고 자동 섹션 heading을 다시 만들지 않는다.
7. JSON export는 canonical optional body와 비워진 structured field를 내려주되 summaryOutdated 같은 UI field를 주입하지 않는다.
8. Knowledge-card chat evidence와 raw summary evidence가 body를 포함하고 stale/outdated summary 차단을 유지하는지 확인한다.
9. body 없는 generated summary의 기존 Markdown, card, corpus, search와 chat output은 byte/shape regression을 만들지 않는다.

## 테스트 (먼저 작성)

- Old knowledge-card/corpus v1 parse와 repository round-trip을 보존하는 RED를 만든다.
- Manual body card/corpus가 body를 포함하되 actionItems/mentionedPeople과 structured fields를 꾸며내지 않는 RED를 만든다.
- Body 길이 cap과 source hash/staleness 판단이 기존 pair hash를 유지하는지 검증한다.
- Body query가 `회의록 본문` reason과 plain-text excerpt로 검색되고 unrelated structured filter가 false인 RED를 만든다.
- Manual body Markdown/copy가 섹션을 재생성하지 않고 title·participants·outdated warning을 정확한 위치에 유지하는 RED를 만든다.
- JSON export가 body를 포함하고 raw canonical contract만 반환하는 route integration RED를 만든다.
- Chat card/raw summary evidence가 body를 포함하면서 outdated summary는 계속 unavailable로 낮추는 RED를 만든다.
- Generated structured summary의 기존 consumer test는 변경 없이 통과해야 한다.

## 문서 최신화

이 phase에서는 문서를 수정하지 않는다. Body의 index/search/filter 의미와 export shape는 Phase 4가 코드와 테스트 결과를 기준으로 기록한다.

## 완료 게이트

```bash
npm test -- src/domain/__tests__/knowledge.test.ts src/lib/__tests__/summaryMarkdown.test.ts src/lib/__tests__/knowledgeIndex.test.ts src/lib/__tests__/knowledgeIndexRepository.test.ts src/lib/__tests__/meetingSearch.test.ts src/lib/__tests__/chatTools.test.ts src/app/api/__tests__/routes.integration.test.ts
npm run typecheck
```
