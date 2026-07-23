# 0022 — 탭 인라인 자유 본문 회의 콘텐츠 편집

- **날짜:** 2026-07-23
- **상태:** 채택됨
- **부분 대체:** ADR [0021](0021-manual-transcript-and-summary-editing.md)의 tab footer 위치와 structured summary form 결정

## 무엇을 결정했나

회의 상세의 transcript와 summary 수정은 읽기 본문 아래에 별도 form을 붙이지 않고 해당 본문을 multiline textarea 하나로 교체한다. 선택된 tabpanel은 tab-local action/status를 첫 content group으로 두며, 그 뒤에 outdated warning과 읽기 본문 또는 editor를 둔다.

- Transcript action은 **복사 / 수정 / 원문에서 다시 만들기** 순서다.
- Summary action은 **복사 / JSON 다운로드 / 수정 / 현재 스크립트로 다시 만들기** 순서다.
- 수정 중에는 confirmed read body와 textarea를 동시에 렌더하지 않는다.
- Tab을 잠시 바꿔도 소유 tab이 `수정 중|저장 중|저장 확인 중|저장 확인 필요`를 표시하고 exact draft를 유지한다. Summary의 `요약 갱신 필요` 표시도 함께 유지한다.

Summary에는 두 canonical mode가 있다.

1. **Generated structured mode:** 기존 `oneLine`, `purpose`, 목록과 action item shape를 migration 없이 읽는다. Editor를 열 때 현재 읽기 순서인 `요약`(oneLine 뒤 highlights) → `목적` → `논의 내용` → `결정 사항` → `액션 아이템` → `리스크` → `후속 확인`의 결정적 plain text로 투영한다. 빈 block은 생략하고 일반 항목은 `- {item}`, action item은 `- {owner} — {task} (기한: {due})`로 쓴다. Block 사이는 LF 두 개이며 trailing LF를 만들지 않는다.
2. **Manual freeform mode:** optional `body`가 현재 요약 내용의 유일한 editable truth다. Existing body는 heading·bullet·공백·내부 개행을 parse하거나 trim하지 않고 그대로 편집한다. CRLF만 LF로 정규화한다.

Body가 있는 canonical summary는 `oneLine`과 `purpose`를 빈 문자열로, highlights/discussion/decisions/actionItems/risks/followups를 빈 배열로 둔다. Body와 non-empty structured editable content가 함께 있는 dual truth는 schema가 거부한다. Manual summary save는 기존 `title`, `topicSlug`, canonical `participants`를 보존한다. 표시 제목은 `titleOverride` writer, review participants는 `status.review` writer가 계속 소유하며 summary editor로 옮기지 않는다.

Body는 detail, summary copy, combined Markdown, canonical JSON export, knowledge card/corpus, deterministic search와 chat evidence의 현재 요약 내용이다. Markdown은 body에 자동 section heading을 다시 만들지 않고 JSON은 optional body와 비워진 structured field를 그대로 반환하며 UI-only `summaryOutdated`를 주입하지 않는다. Manual knowledge card는 body를 담되 structured semantic field, action items와 그로부터 파생되는 mentioned people을 꾸며내지 않는다. Corpus body는 Unicode character 기준 4,000자로 제한하고 검색은 weight 85의 `회의록 본문` field와 deterministic plain-text excerpt를 사용한다. `hasActionItem` filter는 structured action items만 보며 freeform body에서 owner·due·section을 추론하지 않는다.

Copy와 download는 열린 textarea draft가 아니라 마지막 confirmed 저장본을 사용한다. Editor action status가 이 차이를 명시하고, draft 보관이 필요하면 오류 복구의 **내 입력 복사**를 사용한다. Summary는 whitespace-only body와 exact `JSON.stringify({expectedRevision,body})`의 UTF-8 byte length가 512 KiB를 넘는 요청을 network 전에 거부하며 textarea와 exact draft를 유지한다.

저장 실패의 복구는 원인을 합치지 않는다.

| 상태 | 보존·다음 행동 |
|---|---|
| validation / 413 | Exact draft와 textarea focus를 유지하고 입력 또는 길이를 고쳐 재시도 |
| meeting missing/deleted | 더 저장할 수 없음을 알리고 draft copy 제공 |
| content operation in progress | 같은 draft를 유지하고 operation 종료 뒤 재시도 |
| revision conflict | Draft copy 제공, 확인을 한 번 더 거친 뒤에만 latest로 교체 |
| source conflict / ambiguous pair | Draft copy와 fail-closed reload·folder 확인만 제공 |
| network / invalid success | PATCH를 blind retry하지 않고 read-only content probe로 intended/predecessor/third/unavailable 판정 |

Dirty cancel과 다른 editor 전환은 inline discard 확인을 거친다. **계속 수정**을 첫 control과 focus 대상으로 두고 명시적 discard 전에는 draft를 바꾸지 않는다. Saving/verifying에는 discard를 허용하지 않는다.

Summary regeneration은 manual body를 merge하거나 보존하지 않고 current transcript로 body 없는 새 structured summary를 만든다. 이는 freeform text에서 구조를 추론하지 않는 대신 자동 structured mode로 돌아가는 명시적 recovery다.

## 왜

Structured field form은 읽기 화면의 문장·heading·목록을 항목 경계로 다시 분해한다. 사용자가 heading을 지우거나 여러 section을 합치려는 단순 수정도 form 구조에 갇히고, 읽기 본문과 편집 surface가 동시에 보이면 어떤 내용이 저장 대상인지 혼동된다. 읽기 본문 자체를 하나의 plain-text textarea로 바꾸면 보이는 내용과 수정 대상이 일치하고 section 제목도 일반 text로 다룰 수 있다.

반면 generated summary의 structured data와 manual body를 함께 current truth로 두면 copy, export, index와 검색마다 우선순위가 달라질 수 있다. Manual save 시 structured editable field를 비우고 body 하나만 남기면 consumer가 숨은 fallback 없이 같은 내용을 사용한다. Freeform body에서 action item을 추론하지 않는 선택은 structured filter recall을 줄이지만, 사람의 문장을 임의의 담당자·기한으로 오인하지 않는다. 구조화가 다시 필요하면 사용자가 current transcript 기준 summary regeneration을 명시적으로 선택한다.

Confirmed action과 draft action을 분리하면 응답 유실이나 conflict 중에도 copy/download가 미확정 내용을 저장된 사실처럼 내보내지 않는다. Typed recovery와 read-only probe는 exact draft를 보존하면서 중복 PATCH와 조용한 덮어쓰기를 막는다.

## 유지하는 결정

이 ADR은 ADR 0021의 다음 항목만 부분 대체한다.

- content 아래의 tab footer → tablist 직후 panel-local action bar
- `oneLine`·목록·action item별 structured summary form → single freeform summary body textarea

ADR 0021과 ADR [0013](0013-durable-summarize-pair-publication.md)의 full-pair single writer, expected pair revision, operation lease, durable attempt, transcript-first/summary-last publication, freshness, read-only save probe와 navigation guard는 그대로 유지한다. Immutable `audio.webm`·`raw.md`·`segments.json`을 수정하지 않으며 title/participants writer도 바꾸지 않는다. Transcript 변경은 summary를 outdated로 보존하고 summary 직접 저장 또는 regeneration만 fresh로 만든다. Outdated summary는 semantic search나 chat citation evidence로 승격하지 않는다.

## 버린 대안

- **Structured form 유지:** Heading 삭제와 section 재배치를 표현하지 못하고 읽기/편집 shape가 다르다.
- **Body와 structured field 병존:** Consumer마다 우선순위가 갈리는 ambiguous dual truth를 만든다.
- **Body에서 action item 자동 추론:** Model call 없이도 자유 문장을 잘못된 owner·due로 분류할 수 있다.
- **Draft를 copy/download에 사용:** 아직 저장되지 않았거나 commit 여부가 불명확한 내용을 confirmed artifact처럼 내보낸다.
- **Network 오류 뒤 PATCH 재전송:** 첫 요청이 commit된 경우 새 revision에 intent를 중복 적용할 수 있다.
- **Editor를 읽기 본문 아래에 추가:** 같은 tab에 confirmed와 draft surface가 동시에 보여 현재 상태를 모호하게 만든다.

## 검증 경계

반복 browser gate는 ADR [0020](0020-deterministic-synthetic-browser-verification.md)의 repository-owned Playwright scenario를 사용한다. `desktop-1440`, `mobile-390`, `mobile-320`에서 action DOM 순서, read/edit mutual exclusion, summary heading 삭제와 exact save, confirmed-copy 안내, discard focus·cancel restoration, freshness와 horizontal overflow를 synthetic data만으로 검증한다. Screenshot, assertion, console과 manifest evidence는 runner output에 남기며 실제 사용자 데이터·외부 network·Chrome DevTools MCP를 완료 gate로 사용하지 않는다.
