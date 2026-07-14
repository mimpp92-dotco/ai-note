# 0018 — 파생 지식 인덱스와 근거 기반 회의 챗봇

- **날짜:** 2026-07-12
- **상태:** 채택됨

## 결정

회의 지식 검색은 파일 기반 4-tier로 구성한다: 원본 meeting artifact, meeting별 `knowledge-card.json`, 전체 요약 projection인 `corpus-map.json`, 질의 시점의 bounded evidence materialization. 인덱스는 삭제 후 재생성 가능한 파생물이며 기존 `summary.json`과 원본 transcript 스키마를 바꾸지 않는다. SQLite/vector DB는 로컬 규모에서 운영·migration·복구 복잡성이 이득보다 커 v1 이후로 연기한다.

선택적 개인화는 LLM provider 설정과 분리한 `data/user-profile.json` v1에 표시 이름·별칭·IANA timezone·주 시작 요일만 저장한다. Missing profile은 정상 `{configured:false}`이고 일반 검색/질문을 막지 않는다. Public 설정 저장·조회 surface는 local guard와 bounded strict API를 통과하며 profile 파일도 app-api 단일 writer와 durable atomic replace를 사용한다.

Meeting card는 `data/meetings/{id}/knowledge-card.json`, 전체 후보 map은 `data/knowledge/corpus-map.json`에 둔다. Card의 `sourceHashes`는 같은 artifact lease에서 읽은 transcript/summary in-memory bytes로 계산하고, corpus에는 bounded semantic candidate projection만 두며 전체 transcript·absolute path·current-authoritative metadata를 복제하지 않는다. Read mode는 `missing|ready|stale|corrupt|io_error`이며 corrupt bytes를 missing으로 낮추거나 자동 덮어쓰지 않는다.

Card writer는 기존 meeting operation owner 아래 tombstone을 먼저 확인하고 artifact write lease를 얻은 뒤 fence를 다시 확인한다. 그 lease 안에서 strict status와 source pair를 읽고 card를 atomic replace한다. Deleted/ambiguous tombstone, corrupt/unreadable status, unsafe record, missing/malformed/ambiguous pair는 fail-closed한다. Card와 corpus 모두 temp→file fsync→rename→parent-directory fsync를 사용하며 rename이 logical commit이다. Directory sync 미지원은 `best_effort`, rename 뒤 일시 실패는 committed `pending`으로 반환하고 rollback이나 blind replay를 하지 않는다.

`data/knowledge/`를 처음 만들 때 symlink/non-directory를 거부하고 새 directory entry가 놓인 `data/` namespace를 sync한다. Corpus mutation은 absolute canonical corpus path의 process-global queue로 직렬화한다. Rebuild는 common classifier의 live record와 meeting별 fenced artifact-read snapshot을 queue 밖에서 모으고 모든 library/artifact lease를 놓은 뒤에만 corpus queue에서 latest snapshot을 commit한다. 따라서 corpus queue와 library/per-meeting lease를 중첩하거나 summary pair publish lock 순서를 거스르지 않는다.

요약/재요약 publisher가 `summary.json` completion marker를 발행하고 matching attempt를 정리한 뒤에만 별도 repository 호출로 card/corpus 갱신을 시도한다. 이 후속 인덱싱의 missing/stale/corrupt/I/O/pending 결과는 성공한 transcript/summary pair나 `summarized` 상태를 rollback하지 않는다. 기존 회의 복구는 strict `POST /api/knowledge/reindex`의 all/meeting scope로만 제공하고 원본 artifact를 수정하지 않는다.

AI 없는 `GET /api/search`는 corpus/card 후보를 결정적인 NFKC·AND substring·field weight 규칙으로 정렬하고 전체 transcript를 매 요청마다 읽지 않는다. Search/chat consumer는 persisted title/status/location/review snapshot을 current truth로 쓰지 않고 응답 직전 live status/library와 tombstone을 다시 확인한다. Reindex도 common classifier와 tombstone fence에서 unsafe/deleted record를 fail-closed한다. Index reason은 bounded public state로만 노출하고 corrupt를 missing으로 낮추거나 자동 덮어쓰지 않는다.

전체 회의 챗봇은 모델이 직접 전체 파일을 읽거나 링크를 만드는 방식이 아니라 검색·회의 조회 도구를 호출한다. 서버는 반환 직전 tombstone을 재검증하고, persisted index의 title/status/location/reviewParticipants snapshot을 public current truth로 쓰지 않으며 live status/library metadata를 결합한다.

`POST /api/chat`는 기존 configured CLI/Ollama adapter를 재사용하는 bounded non-streaming JSON loop이며 `get_user_profile`, `search_meetings`, `search_transcripts`, `read_knowledge_cards`, `read_summaries`, `read_transcript_chunks`, `read_full_transcript`만 허용한다. 새 provider/API-key surface, background chat job, 서버 영구 대화 저장소를 만들지 않는다. UI history는 현재 browser tab의 완결 4 turn만 유지한다.

`search_transcripts`는 요약 기반 `search_meetings`가 고유명사·별칭 의역으로 놓친 회의를 위한 discovery 전용 도구다. AI 없는 `GET /api/search`는 여전히 transcript 전문을 매 요청마다 읽지 않지만, 챗봇 도구 계층에는 bounded transcript discovery가 추가되어 `transcriptScans` budget 안에서 artifact read lease로 전사 본문을 훑고 bounded snippet만 반환한다. Discovery(`search_meetings`·`search_transcripts`) 결과는 citation credit을 만들지 않으며, 찾은 meetingId를 summary/card/transcript read 도구로 다시 읽어야만 claim 근거가 된다. Adapter가 코드블록·머리말·`--output-format json` wrapper로 감싼 응답을 돌려줘도 공유 `extractJsonObject` salvage로 첫 균형 JSON 객체를 뽑아 envelope로 해석하고, 그래도 실패할 때만 요청당 한 번의 repair를 소비한다.

검색·질문 UI 진입은 별도 `/search` 탭 페이지가 아니라 앱 셸의 두 표면이다: 좌측 rail/모바일 drawer 최상단 돋보기 트리거가 여는 shared `SearchOverlay`(native top-layer `AppDialog`)와, 우측 접이식 `회의 도우미` 챗봇 패널(desktop `<aside>` · mobile `AppDrawer`). 두 표면은 같은 `useMeetingSearch`/`SearchPanel`과 hoisted `useChatController`/`ChatClient`를 재사용하며, 챗봇 답변의 검색 액션은 페이지 이동 없이 같은 오버레이를 열고 `searchReplay`를 한 번 재생한다. `/api/search`·`/api/chat` 서버 계약과 evidence ledger 규칙은 이 UI 재배치로 바뀌지 않는다.

서버 evidence ledger가 모델에 제공한 validated meeting ID와 claim의 사용 관계를 기록한다. 응답은 claim-level inline citation과 `evidenceStatus`를 가지며, 이는 semantic entailment 판정이 아니라 provenance 검사다. 모델은 raw reference 번호·title·link를 생성하지 않는다. 서버가 실제 인용된 meeting에 한해 첫 등장 순서로 stable `[n]`을 부여하고 안전한 app-relative link와 reference list를 만든다.

프로필 미설정은 `{configured:false}`이며 일반 검색/질문의 실패가 아니다. `reviewParticipants`는 `status.review`만 authoritative다. v1 `mentionedPeople`은 placeholder가 아닌 action item owner처럼 deterministic source만 사용하고 별도 LLM 추출이나 추측 인명 인식을 하지 않는다.

프로필·card·corpus는 gitignored `data/`에 남고 단순 검색은 모델을 호출하지 않는다. Chat은 질문/history와 선택한 bounded evidence를 configured adapter에만 전달한다. Ollama는 loopback 경계이고, Claude/Codex CLI의 provider-side 처리는 사용자가 로그인한 CLI 정책을 따른다. 앱은 API credential, raw prompt/tool trace, chat history를 별도 저장하지 않는다.
