# 0016 — Finalize는 receipt를 포함한 directory rename으로 publish

- **날짜:** 2026-07-10
- **상태:** 채택됨

## 무엇을 결정했나

Meeting finalize는 request body를 읽기 전에 deterministic hidden staging의 versioned intent를 create-exclusive로 내구 기록한다. Audio temp write·file sync·rename 후 initial `status.json`과 immutable `.finalize-receipt.json`을 같은 staging에 완성하고 intent를 제거한 다음, exclusive meeting operation→artifact write lease 아래 staging directory를 canonical `data/meetings/{id}`로 rename한다. 이 directory rename이 recording의 logical publish다.

Receipt는 validated metadata, original requested location/source, acceptance time, audio SHA-256을 보존한다. Same-ID retry는 final directory가 있으면 replacement body를 읽지 않고 receipt, playback, canonical placement, durable transcription dispatch를 조합해 결과를 probe한다. Publish 뒤 remux·placement·transcription은 독립 결과이며 일부 실패도 recording upload를 실패로 되돌리지 않는다.

Initial status의 matching `placementResolution:{state,receiptHash}`가 `pending|unavailable`이면 generic library reconcile은 default placement 생성을 defer한다. Receipt resolver가 exact/fallback placement를 commit한 뒤에만 `resolved`로 바꾼다. Existing canonical placement는 receipt intent보다 우선한다. Canonical placement 없는 pending/unavailable meeting은 별도 bounded `organization-pending` resource와 count로 발견 가능하다.

## 왜

Audio를 바로 final path에 쓴 뒤 status·placement·dispatch를 순차 처리하면 crash/response loss가 status-only/audio-only record, immutable audio 재업로드 요구, 원래 requested location 유실을 만든다. Directory 단위 publish와 immutable receipt를 쓰면 visible record의 최소 원자성을 지키고, post-publish 작업은 same ID로 안전하게 복구할 수 있다.

## 버린 대안

- Final `audio.webm`을 먼저 쓰고 status를 나중에 생성: scanner에 부분 record가 노출된다.
- 이미 published retry를 409로 거절: response loss 후 client가 저장 성공 여부와 후속 작업 상태를 복구할 수 없다.
- Placement 실패 시 generic reconcile에 맡김: requested folder보다 default workspace가 먼저 materialize될 수 있다.
- Request body/위치만 메모리에 유지: process restart 뒤 metadata와 destination을 증명할 수 없다.
- Placement 실패를 finalize 5xx로 반환: immutable audio의 불필요한 재업로드를 유도한다.

## 영향받는 곳

`finalizeRecord.ts`, `finalizePlacement.ts`, finalize/location/organization-pending routes, `status.placementResolution`, library reconcile policy, recorder transition response. Logical delete는 ADR [0015](0015-durable-meeting-tombstone.md), post-publish transcription은 ADR [0014](0014-durable-transcription-dispatch.md), lock 순서는 ADR [0013](0013-durable-summarize-pair-publication.md)를 따른다.
