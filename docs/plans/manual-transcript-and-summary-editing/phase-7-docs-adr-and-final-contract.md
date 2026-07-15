# Phase 7 — docs-adr-and-final-contract

구현·테스트·synthetic browser evidence로 확인된 수동 편집, 독립 transcript/summary generation, freshness, save probe, 버튼 위계, navigation guard를 사람·에이전트 정본과 새 ADR 0020에 반영한다. 기존 ADR은 과거 결정으로 보존한다.

## 읽어야 할 파일

- `AGENTS.md`
- `README.md`
- `src/CLAUDE.md`
- `docs/PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/UI_GUIDE.md`
- `docs/decisions/README.md`
- `docs/decisions/0000-template.md`
- `docs/decisions/0003-local-files-single-writer.md`
- `docs/decisions/0008-title-override.md`
- `docs/decisions/0009-async-resummarize-failure-visibility.md`
- `docs/decisions/0013-durable-summarize-pair-publication.md`
- `docs/decisions/0018-meeting-knowledge-index-and-chatbot.md`
- `scripts/check-links.mjs`

## 요구사항

- R10: 제품·아키텍처·UI·에이전트 문서와 새 ADR을 실제 최종 계약에 맞춘다.

## 허용 범위

- `AGENTS.md`
- `README.md`
- `src/CLAUDE.md`
- `docs/PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/UI_GUIDE.md`
- `docs/decisions/README.md`
- `docs/decisions/0020-manual-transcript-and-summary-editing.md`

## 금지 및 중단 조건

- `data/**`
- `.env*`
- `glossary.json`
- `src/**/*.ts`
- `src/**/*.tsx`
- `whisper/**`
- `docs/decisions/000*.md`
- `docs/decisions/001*.md`
- 기존 ADR 0003, 0008, 0009, 0013, 0018 수정이 필요하면 중단하고 새 ADR 0020에서 관계를 설명한다.
- 문서 갱신을 위해 runtime source 수정이 필요하면 중단한다.
- 원본 불가침, 단일 writer, local guard, tombstone, 비용 0 원칙과 모순되는 서술이 필요하면 중단한다.
- 허용 범위 밖 파일 수정이 필요하면 중단한다.

## 작업

1. `README.md`에 요약 완료 뒤 전체 스크립트와 회의록 요약을 각각 직접 수정할 수 있다는 기능과 다음 사용자 흐름을 짧게 추가한다.
   - 최초 생성은 raw correction + summary 자동 생성.
   - `원문에서 스크립트 다시 만들기`는 transcript만 변경.
   - `현재 스크립트로 요약 다시 만들기`는 summary만 변경.
   - transcript 변경 뒤 `요약 갱신 필요`, summary direct save/regeneration 뒤 fresh.
2. `docs/PRD.md`의 상세, 교정+요약, 단건 재생성 요구사항을 두 독립 operation으로 갱신한다. Non-goal에 raw edit, history/merge/autosave, combined post-initial regeneration을 추가한다.
3. `docs/ARCHITECTURE.md`에 다음 정본 계약을 추가한다.
   - `contentRevision` transcript/summary schema와 legacy virtual fresh 해석.
   - summaryOutdated 파생식과 source conflict fail-closed.
   - manual edit GET probe/PATCH body cap/expected pair revision/typed errors.
   - initial, transcript_regenerate, summary_regenerate, manual_edit durable attempt와 legacy resummarize recovery.
   - transcript-only와 summary-only의 exact LLM call/data source/publisher payload.
   - manual interruption이 retry_summary/error counter를 만들지 않는 recovery.
   - outdated index/search/chat/export policy와 fresh 뒤 index refresh.
4. `AGENTS.md`와 `src/CLAUDE.md`의 summary pair/single-writer/detail pattern을 갱신한다.
   - API/UI가 canonical artifact를 직접 쓰지 않는다.
   - transcript 변경은 summary를 자동 재생성하지 않고 outdated로 만든다.
   - summary generation은 current transcript만 사용한다.
   - raw correction은 transcript regeneration에서만 사용하며 raw는 불변이다.
   - manual save/independent generation 모두 publisher와 lock order를 따른다.
5. `docs/UI_GUIDE.md` 상세 section을 browser evidence와 일치시킨다.
   - top global action과 두 tab bottom footer의 exact button 목록.
   - item별 multiline-safe summary editor.
   - summaryOutdated tab/panel/copy/Markdown/JSON 안내.
   - save state machine과 typed next action.
   - 두 destructive generation dialog의 copy, cancel initial focus, busy dismiss 차단.
   - generic unsaved navigation guard, audio+content combined dialog, saving/verifying behavior.
   - desktop/mobile footer, 44px, overflow, focus 규칙.
6. `docs/decisions/0020-manual-transcript-and-summary-editing.md`를 새로 작성한다.
   - 결정: immutable raw와 editable derived transcript/summary 구분.
   - 결정: 최초만 combined pipeline, 이후 independent transcript-only/summary-only generation.
   - 결정: full pair publisher를 유지하면서 unchanged opposite artifact를 함께 발행.
   - 결정: contentRevision과 basedOnTranscriptSha256로 freshness 파생.
   - 결정: outdated summary 보존 + consumer warning/stale index, fresh 뒤 refresh.
   - 결정: expected pair revision, read-only save probe, typed error.
   - 결정: manual interruption은 LLM retry error가 아님.
   - 결정: global/tab-local action hierarchy와 unsaved navigation guard.
   - 버린 대안: raw 직접 수정, 별도 override 파일, last-write-wins, post-initial combined regenerate, transcript change 직후 silent summary refresh, stale summary current indexing, network error blind retry, newline-split list editor, navigation loss 허용.
   - ADR 0003/0008/0009/0013/0018과의 관계.
7. `docs/decisions/README.md`에 0020 링크와 한 줄 요약을 추가한다. 파일을 먼저 만든 뒤 링크를 추가한다.
8. 모든 문서에서 title과 participants는 기존 전용 writer를 유지하고 internal topicSlug/summary.participants는 편집하지 않는다고 일치시킨다.
9. 사용자 문서는 `raw.md`, attempt kind, SHA-256 같은 내부 용어 대신 “최초 자동 전사 원문”, “현재 전체 스크립트”, “요약 갱신 필요”를 사용한다. 아키텍처·ADR만 exact field/operation을 기록한다.
10. phase 6 browser evidence의 실제 label, mobile layout, focus 결과와 문서 copy를 대조한다. 계획 문구가 구현/evidence와 다르면 문서가 아니라 허용된 문서 범위 안에서 실제 동작을 정확히 서술한다.

## 테스트 (먼저 작성)

- docs-only phase라 runtime TDD는 면제한다.
- 문서 수정 전에 구현의 route, request/response, status field, operation kind, UI label, error code를 직접 대조한다.
- README/PRD/ARCHITECTURE/UI_GUIDE/AGENTS/src/CLAUDE에서 initial/transcript-only/summary-only 의미가 서로 모순되지 않는지 검색한다.
- legacy `다시 요약`이 raw correction + summary를 계속 수행한다는 stale 문구를 제거하되 ADR 0009의 historical text는 수정하지 않는다.
- 새 ADR 파일이 실제로 존재한 뒤 decisions index 링크를 추가한다.
- check-links 실패 시 broken target이나 stale path만 허용 범위 안에서 고친다.

## 문서 최신화

- 이 phase 자체가 최종 문서 최신화 단계다.
- 기존 ADR은 수정하지 않는다. 현재 결정의 정제·확장은 ADR 0020만 소유한다.
- 사용자 문서는 path, attempt ID, raw provider/fs output을 노출하지 않는다.

## 완료 게이트

```bash
npm run check:links
```
