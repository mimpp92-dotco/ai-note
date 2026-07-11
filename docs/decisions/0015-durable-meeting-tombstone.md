# 0015 — Durable meeting tombstone이 logical delete commit

- **날짜:** 2026-07-10
- **상태:** 채택됨(ADR [0007](0007-delete-meeting-record.md) 대체)

## 무엇을 결정했나

Permanent delete는 `data/meeting-tombstones/{safe-id}.json`의 strict `{id,deletedAt}` marker를 durable rename하는 시점에 logical commit한다. Marker는 data-root reset 전까지 영구 보존하고 live directory보다 우선한다. 모든 reader/writer/worker/scanner/status critical section은 valid 또는 ambiguous tombstone을 fail-closed fence로 사용한다.

Placement cleanup, live→deterministic `.trash-{id}` rename, recursive remove는 논리 commit 후의 재시도 가능한 physical cleanup이다. Guarded access가 restart sweep을 lazy/deduplicated로 시작한다. Malformed·unreadable·symlink marker/trash는 숨기되 추측해 수정·삭제하지 않는다.

## 왜

Directory rename만으로는 separate Whisper 프로세스나 response-loss retry가 same ID 폴더를 다시 만드는 것을 영구적으로 막지 못한다. 논리 삭제를 작은 내구 marker로 분리하면 physical rm·registry I/O·late producer 실패가 삭제를 되돌리지 못한다.

## 버린 대안

- Meeting directory rename을 logical commit으로 유지: late writer가 same ID를 부활시킨다.
- `status.json.deleted` soft flag: status가 없거나 손상된 record/finalize pre-status를 fence하지 못한다.
- Cleanup 성공 후 tombstone 삭제: 늦은 Whisper/finalize retry가 ID를 재생성할 수 있다.
- Ambiguous marker를 valid/none으로 추측: 민감한 로컬 회의를 조용히 복구·삭제할 수 있다.

## 계승한 결정

- ADR 0007의 rename-then-rm은 physical cleanup 단계로 유지한다.
- 전사 취소를 강제하지 않고 late raw/segments orphan을 허용하되, tombstone으로 영구 숨기고 sweep에서 수거한다.
- 로컬 단일 사용자 export에는 현재 token/email/PII scrub을 적용하지 않는다. 공유/업로드 표면이 생기면 강제한다.

## 영향받는 곳

`meetingTombstone.ts`, `meetingCleanup.ts`, status updater, library scanner/repository, all meeting routes/RSC/workers, meeting DELETE. Lock 순서와 artifact reader/publisher는 ADR [0013](0013-durable-summarize-pair-publication.md), late transcription identity는 ADR [0014](0014-durable-transcription-dispatch.md)를 따른다.
