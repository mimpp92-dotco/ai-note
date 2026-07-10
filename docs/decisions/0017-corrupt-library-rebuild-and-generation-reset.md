# 0017 — 손상된 library는 원본 보존형 명시적 재구축만 허용

- **날짜:** 2026-07-10
- **상태:** 채택됨

## 무엇을 결정했나

`data/library.json`이 `corrupt`일 때만 사용자가 최신 SHA-256 fingerprint를 확인 입력과 함께 보내 명시적으로 재구축할 수 있다. Executor는 `data/library-recovery/` 아래에 이름·경로를 담지 않는 UUID 기반 intent/new/archive/restore 파일을 만들고, pure recovery planner가 지시한 action만 같은 absolute library queue 안에서 수행한다.

원본 canonical은 새 문서보다 먼저 private archive(`0700` directory, `0600` file where supported)로 rename하고 두 namespace를 sync한다. 새 registry는 live meeting classifier 결과만 새 기본 workspace의 unfiled에 배치하며 새 `libraryId`, revision `0`을 사용한다. Intent phase 갱신도 temp write→file fsync→rename→directory fsync이며 active marker를 제자리 truncate하지 않는다. Required directory durability를 보장할 수 없거나 path/hash/intent가 모호하면 `recovery_not_supported|recovery_conflict|recovery_io`로 fail-closed한다. Archive는 로컬 PII를 포함할 수 있어 자동 삭제하지 않는다.

클라이언트는 재구축 성공 뒤 monotonic generation epoch를 올리고 old request/mutation을 abort한다. Page/entity/cursor, scope, expanded folder, dialog/form, summary-work, organization-pending을 함께 폐기하고 새 default workspace All로 URL을 replace한다. 열린 detail은 server-resolved source ID로 다시 읽고 stale source query를 canonical URL로 교체한다. Recorder가 capture/upload/retained Blob을 소유하는 동안 재구축 action은 비활성화한다.

## 왜

손상 파일을 missing으로 취급해 bootstrap하면 workspace/folder/placement와 손상 원본을 동시에 잃는다. 반대로 archive와 crash-resumable intent를 먼저 내구화하면 모든 중단 지점에서 원본 또는 검증된 archive를 보존하면서 재시작할 수 있다. 새 generation identity는 revision `0` 숫자만 비교할 때 생기는 ABA를 막고, 늦은 old-library 응답이 재구축 뒤 UI를 되살리지 못하게 한다.

## 버린 대안

- Corrupt/unsupported/I/O를 자동 bootstrap: 원본 상태와 조직 metadata를 조용히 덮으므로 기각.
- Caller가 archive path/recovery ID를 지정: traversal·symlink·PII filename 표면을 만들므로 기각.
- Intent를 `O_TRUNC`로 제자리 갱신: write 중 crash가 유일한 restart marker를 훼손하므로 기각.
- Directory sync unsupported에서 best-effort rebuild: 원본 archive와 canonical 전환을 함께 증명할 수 없어 기각.
- Revision만 초기화하고 기존 client cache 유지: old generation revision과 ABA가 생겨 기각.

## 영향받는 곳

`libraryRecoveryIntent.ts`, `libraryRecoveryPlanner.ts`, `libraryRecoveryExecutor.ts`, `/api/library/rebuild`, `libraryService.ts`, `LibraryRecoveryPanel`, `LibraryProvider`, `HomeClient`, `LibraryNavigation`, `MeetingDetailView`. Registry/commit 기반은 ADR [0011](0011-library-registry-and-durable-commits.md), finalize receipt 해석은 ADR [0016](0016-atomic-finalize-directory-publication.md), tombstone 우선순위는 ADR [0015](0015-durable-meeting-tombstone.md)를 따른다.
