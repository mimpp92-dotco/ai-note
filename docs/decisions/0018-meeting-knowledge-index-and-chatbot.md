# 0018 — 파생 지식 인덱스와 근거 기반 회의 챗봇

- **날짜:** 2026-07-12
- **상태:** 채택됨

## 결정

회의 지식 검색은 파일 기반 4-tier로 구성한다: 원본 meeting artifact, meeting별 `knowledge-card.json`, 전체 요약 projection인 `corpus-map.json`, 질의 시점의 bounded evidence materialization. 인덱스는 삭제 후 재생성 가능한 파생물이며 기존 `summary.json`과 원본 transcript 스키마를 바꾸지 않는다. SQLite/vector DB는 로컬 규모에서 운영·migration·복구 복잡성이 이득보다 커 v1 이후로 연기한다.

전체 회의 챗봇은 모델이 직접 전체 파일을 읽거나 링크를 만드는 방식이 아니라 검색·회의 조회 도구를 호출한다. 서버는 반환 직전 tombstone을 재검증하고, persisted index의 title/status/location/reviewParticipants snapshot을 public current truth로 쓰지 않으며 live status/library metadata를 결합한다.

서버 evidence ledger가 모델에 제공한 validated meeting ID와 claim의 사용 관계를 기록한다. 응답은 claim-level inline citation과 `evidenceStatus`를 가지며, 이는 semantic entailment 판정이 아니라 provenance 검사다. 모델은 raw reference 번호·title·link를 생성하지 않는다. 서버가 실제 인용된 meeting에 한해 첫 등장 순서로 stable `[n]`을 부여하고 안전한 app-relative link와 reference list를 만든다.

프로필 미설정은 `{configured:false}`이며 일반 검색/질문의 실패가 아니다. `reviewParticipants`는 `status.review`만 authoritative다. v1 `mentionedPeople`은 placeholder가 아닌 action item owner처럼 deterministic source만 사용하고 별도 LLM 추출이나 추측 인명 인식을 하지 않는다.
