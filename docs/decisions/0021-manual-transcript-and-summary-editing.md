# 0021 — 전체 스크립트·회의록 요약의 수동 수정과 독립 재생성

- **날짜:** 2026-07-15
- **상태:** 채택됨

## 무엇을 결정했나

녹음·최초 자동 전사 원문은 불변 원본으로 유지하고, 그로부터 만든 canonical `transcript.md`와 `summary.json`만 편집 가능한 파생물로 취급한다. 사용자는 회의 상세의 두 탭에서 전체 스크립트와 회의록 요약을 각각 직접 저장할 수 있다. Summary editor는 `oneLine`·`purpose`·목록·action item만 편집하며 `title`, `topicSlug`, `summary.participants`는 보존한다. 표시 제목은 ADR 0008의 `titleOverride`, 참석자는 `status.review` 전용 writer가 계속 소유한다.

최초 생성만 immutable `raw.md`를 교정하고 그 결과를 요약하는 결합 pipeline이다. 그 뒤에는 다음 operation을 분리한다.

- `transcript_regenerate`: immutable raw와 현재 glossary로 correction만 한 번 실행하고 current summary는 그대로 보존한다.
- `summary_regenerate`: current canonical transcript로 summary만 만들고 raw correction은 실행하지 않는다.
- `manual_edit`: LLM을 호출하지 않고 transcript 또는 editable summary projection을 저장한다.

Canonical 두 파일의 단일 writer는 계속 app summarize publisher다. API/UI/adapter는 직접 쓰지 않으며, transcript-only mutation도 unchanged summary를, summary-only mutation도 unchanged transcript를 포함한 full pair를 기존 ADR 0013의 staging·manifest·transcript-first/summary-last protocol로 발행한다. 반대편 파일을 별도 override 파일로 갈라놓지 않는다.

`status.contentRevision`에 transcript/summary의 `source`, SHA-256, `updatedAt`과 summary의 `basedOnTranscriptSha256`를 둔다. `summaryOutdated`는 base transcript hash와 current transcript hash의 불일치로만 파생한다. Legacy pair는 persisted revision이 없어도 actual pair hash를 generated+fresh virtual revision으로 읽되 read가 status write를 만들지 않는다. Persisted revision과 canonical bytes가 충돌하면 `source_conflict`로 fail-closed한다.

Transcript 변경 뒤 기존 summary는 삭제하거나 조용히 다시 만들지 않고 `요약 갱신 필요` 상태로 보존한다. Outdated summary는 detail/copy/Markdown에서 warning을 동반하고, index/search/chat에서는 current semantic summary로 취급하지 않는다. Summary 직접 저장 또는 current transcript 기준 재생성이 fresh 상태를 만들며 그때만 index refresh를 시도한다. Index refresh 실패는 이미 commit된 content pair를 rollback하지 않는다.

모든 수동 저장과 post-initial generation은 expected full-pair revision을 요구한다. 네트워크 오류나 invalid success body 뒤에는 같은 mutation을 blind retry하지 않고 read-only content probe로 intended/pre-save/third revision을 구분한다. Conflict·operation-in-progress·source-conflict·ambiguous·save-unavailable은 typed public error로 반환하고 path/hash/attempt/provider/fs output은 노출하지 않는다. Manual publication interruption은 모델 실패가 아니므로 old pair를 유지하고 durable attempt만 정리하며 `summarizeAttempts` 증가나 새 `retry_summary` error를 만들지 않는다.

UI hierarchy는 global **회의 이동 / 폴더 열기 / 회의록 다운로드(.md)**와 tab-local actions를 분리한다. 전체 스크립트 footer는 **복사 / 수정 / 원문에서 스크립트 다시 만들기**, summary footer는 **요약 복사 / JSON 다운로드 / 수정 / 현재 스크립트로 요약 다시 만들기**를 소유한다. 두 replacement generation은 취소 initial-focus dialog를 거치며 busy 중 dismiss를 막는다. Dirty/saving/verifying editor는 recorder와 같은 layout-level navigation guard에 등록하고, saving/verifying 중에는 discard를 허용하지 않는다.

## 왜

원본과 사람이 고친 파생물을 구분해야 재교정·복구가 가능하면서도 최초 증거를 잃지 않는다. 그러나 transcript와 summary를 독립 파일로 last-write-wins 저장하면 두 파일 사이의 의미적 기준과 crash 시 generation 일관성을 잃는다. 기존 full-pair publisher를 유지하고 revision metadata만 더하면 ADR 0013의 crash consistency를 재사용하면서도 어떤 쪽이 실제로 바뀌었고 summary가 어느 transcript를 근거로 하는지 결정적으로 판정할 수 있다.

사용자는 오탈자 하나를 고치기 위해 긴 회의 전체를 모델에 다시 보내거나, summary 문장 하나를 고친 뒤 transcript까지 다시 생성하길 원하지 않는다. 반대로 transcript가 바뀐 사실을 숨긴 채 예전 summary를 검색·질문 근거로 쓰면 정확성 문제가 생긴다. 독립 operation, 명시적 outdated 상태, fresh 뒤 index refresh가 비용과 통제권·검색 정확성을 함께 지킨다.

로컬 앱에서도 background generation, polling refresh, 수동 저장, navigation이 겹친다. Expected pair revision과 read-only probe는 덮어쓰기와 응답 유실 뒤 중복 mutation을 막고, navigation guard는 draft와 저장 판정이 끝나기 전에 화면 수명과 함께 사라지는 것을 막는다.

## 버린 대안

- **최초 자동 전사 원문 직접 수정**: 복구·재교정 기준과 원본 불가침을 잃는다.
- **별도 manual override 파일**: reader마다 merge 우선순위를 구현하고 pair publisher·export·index의 정본이 갈라진다.
- **Last-write-wins 저장**: polling/다른 탭/연속 mutation이 최신 사용자 수정을 조용히 덮을 수 있다.
- **최초 생성 뒤에도 correction+summary 결합 재생성**: 한쪽만 바꾸려는 요청에 불필요한 LLM call과 반대편 변경을 만든다.
- **Transcript 변경 직후 summary 자동 갱신**: 사용자의 명시적 비용·replacement 선택 없이 오래 걸리는 모델 작업을 시작하고 수동 summary를 덮을 수 있다.
- **Outdated summary를 current index에 유지**: 검색·질문이 현재 transcript와 맞지 않는 semantic evidence를 최신으로 가장한다.
- **Network error 뒤 mutation blind retry**: 첫 요청이 이미 commit됐을 때 같은 intent를 새 revision에 중복 적용할 수 있다.
- **목록 textarea를 newline으로 split**: 한 항목 안의 의도한 개행을 잃고 항목 경계를 가역적으로 복원할 수 없다.
- **Navigation loss 허용**: route unmount/browser back에서 dirty draft나 저장 판정 중인 입력을 복구할 수 없다.

## 영향받는 곳

- Domain/read/write: `src/domain/meeting.ts`, `src/domain/summarySchema.ts`, `src/lib/artifactPair.ts`, `src/lib/manualMeetingContent.ts`, `src/lib/summarize.ts`, `src/lib/summarizePublisher.ts`.
- API/UI: `src/app/api/meetings/[id]/content`, `transcript`, `transcript/regenerate`, `summary`, `summarize`; `src/components/MeetingContentEditors.tsx`, `MeetingDetailView.tsx`, `RecorderSessionProvider.tsx`.
- Consumers: knowledge index, deterministic search, chat tools, copy와 Markdown/JSON export.
- ADR [0003](0003-local-files-single-writer.md)의 immutable raw/단일 writer를 유지하면서 editable derived pair를 명확히 한다. ADR [0008](0008-title-override.md)의 제목 writer와 review participants writer를 summary editor 밖에 둔다.
- ADR [0009](0009-async-resummarize-failure-visibility.md)의 async acceptance·실패 가시성은 summary-only generation에 계속 적용하되, 새 요청은 historical combined `resummarize` 대신 independent kind를 기록한다. Legacy `resummarize`는 restart recovery에서만 호환한다.
- ADR [0013](0013-durable-summarize-pair-publication.md)의 full-pair publication·lock order·reconciliation을 수동 저장과 독립 generation으로 확장하며 대체하지 않는다. ADR [0018](0018-meeting-knowledge-index-and-chatbot.md)의 derived-index non-rollback 원칙을 유지하고 outdated source를 stale로 낮춘다.
- Browser 검증은 ADR [0020](0020-deterministic-synthetic-browser-verification.md)의 isolated synthetic Playwright 3-viewport gate와 evidence 형식을 그대로 사용한다. 실제 사용자 데이터나 Chrome DevTools MCP를 완료 gate로 사용하지 않는다.
