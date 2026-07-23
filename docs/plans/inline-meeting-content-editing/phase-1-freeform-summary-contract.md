# Phase 1 — freeform summary contract

구조화 요약과 수동 자유 본문을 구분하는 canonical schema와 저장 API를 TDD로 고정한다. 기존 구조화 파일은 그대로 읽고, 사용자가 수동 저장한 순간부터 optional body 하나만 editable current truth가 된다.

## 읽어야 할 파일

저장소의 원본 불가침·single-writer 지침, ADR 0013/0021의 full-pair publication과 revision 계약, summary schema, manual content service, content/summary route와 관련 테스트를 모두 읽는다. 새 helper는 UI와 server가 같은 deterministic body projection·정규화를 공유할 수 있는 pure module이어야 한다.

## 요구사항

- R3의 single-body 편집 입력을 server가 손실 없이 받을 계약을 만든다.
- R4의 legacy compatibility, optional body, exact manual-save shape와 regeneration 경계를 만든다.
- R5의 durable pair publication, expected revision, freshness와 probe 불변식을 유지한다.
- R7의 deterministic projection, ambiguous dual-truth rejection과 오류 판정에 필요한 exact resource를 만든다.

## 허용 범위

요약 타입·schema, pure summary-body helper, manual content service와 그 schema/service/API integration 테스트만 수정한다. Route wrapper는 기존 service 결과를 투영하므로 범위를 넓혀 직접 artifact logic을 추가하지 않는다.

## 금지 및 중단 조건

- immutable artifact나 pair publisher를 수정하지 않는다.
- title/topicSlug/participants writer를 summary body editor로 옮기지 않는다.
- manual body와 non-empty 구조화 editable field를 동시에 현재 내용으로 허용하지 않는다.
- API cap, provider, prompt, dependency를 바꾸지 않는다.
- 범위가 부족하면 다른 파일을 임의로 열지 않고 중단한다.

## 작업

1. `summary.json`의 기존 required structured shape를 계속 수용하면서 optional plain-text `body`를 허용한다. `body`가 있으면 whitespace-only를 거부하고 oneLine/purpose와 모든 structured list/action item이 비어 있어야 하며, title/topicSlug/participants는 그대로 허용한다.
2. Pure helper가 structured summary를 현재 detail 읽기 순서의 결정적 plain text로 만든다. Existing `body`가 있으면 변환하지 않고 그대로 반환한다. Structured projection은 아래 형식을 정본으로 한다.
   - 첫 block은 `요약`; 다음 줄에 non-empty oneLine을 두고 highlights는 같은 block의 `- {item}` bullet로 이어서 별도 `핵심` heading을 만들지 않는다.
   - 이후 non-empty block은 `목적`, `논의 내용`, `결정 사항`, `액션 아이템`, `리스크`, `후속 확인` 순서다.
   - 일반 list는 `- {item}`, action item은 `- {owner} — {task} (기한: {due})`다. Item 내부 개행은 바꾸지 않는다.
   - Block 사이는 정확히 `\n\n`, line 사이는 `\n`이고 끝에 synthetic newline을 붙이지 않는다.
   - 표시 제목·topicSlug·participants는 projection에 넣지 않는다.
3. manual body는 CRLF만 LF로 바꾸고 whitespace-only를 거부한다. 공백, 섹션 제목, bullet 문자와 내부 개행은 trim하거나 parse하지 않는다.
4. summary PATCH는 strict expected revision과 자유 body만 받는다. Unknown structured form field와 internal field는 거부한다.
5. 저장 시 canonical title/topicSlug/participants를 보존하고 `body`를 기록하며 oneLine/purpose를 빈 문자열, 모든 list/action item을 빈 배열로 만들어 dual truth를 없앤다.
6. content read와 save success는 internal field를 제외한 `summaryBody`를 반환한다. Probe가 intended body, old revision, third revision과 ambiguous state를 기존 방식으로 구분할 수 있어야 한다.
7. manual save는 current transcript hash 기준 fresh revision과 source manual을 기록하고 full pair publisher 뒤 knowledge refresh를 시도한다.
8. generated summary에는 body가 없으므로 기존 initial/summary regeneration 결과가 자연스럽게 structured mode로 돌아오는지 기존 producer 계약으로 검증한다.

## 테스트 (먼저 작성)

- Existing happy/fallback fixture와 body 없는 legacy summary가 그대로 parse되는 RED를 만든다.
- Optional body가 exact newline/heading text를 보존하고 whitespace-only 또는 body+non-empty structured field의 ambiguous shape를 거부하는 RED를 만든다.
- Structured summary의 exact heading/bullet/action 표기, 빈 section 생략, block separator, no trailing LF와 existing body passthrough를 pure helper test로 고정한다.
- GET content가 initial structured projection을 `summaryBody`로 반환하고 internal field를 숨기는 RED를 만든다.
- PATCH가 exact `{expectedRevision,body}`만 수락하고 CRLF를 LF로 저장하며 whitespace-only/unknown field를 거부하는 RED를 만든다.
- Canonical 저장 결과가 title/topicSlug/participants를 보존하고 structured editable field를 비우며 body만 current content로 갖는지 확인한다.
- Publisher payload가 unchanged transcript와 새 summary full pair이고 source manual/fresh revision이며 index refresh가 성공과 독립적인지 확인한다.
- Network/invalid success probe가 body로 intended/old/third/ambiguous를 구분할 수 있는 resource shape를 유지한다.
- Summary regeneration producer가 manual body를 merge하거나 보존하지 않는 기존 회귀를 유지한다.

## 문서 최신화

이 phase에서는 정본 문서를 수정하지 않는다. 최종 field 이름과 API shape는 Phase 4가 검증된 구현을 기준으로 문서화한다.

## 완료 게이트

```bash
npm test -- src/domain/__tests__/summarySchema.test.ts src/lib/__tests__/manualMeetingContent.test.ts src/app/api/__tests__/routes.integration.test.ts
npm run typecheck
```
