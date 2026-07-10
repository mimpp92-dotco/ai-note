# 0011 — 중앙 library registry·stable meeting path·내구 commit

- **날짜:** 2026-07-10
- **상태:** 채택됨

## 무엇을 결정했나

Workspace, 최대 3단계 folder, meeting placement를 중앙 `data/library.json` v1에 저장한다. Meeting artifact directory `data/meetings/{id}/`는 조직 이동과 무관하게 안정적으로 유지한다. Registry는 app의 `src/lib/library.ts`만 쓰며 absolute canonical path process queue와 generation token `libraryId + revision`으로 직렬화한다.

Folder/workspace 삭제도 meeting 삭제가 아니라 registry 한 번의 preservation transform이다. Folder는 direct placement를 parent/unfiled로 옮기고 direct child를 relative-order block으로 승격하며, normalized sibling name conflict가 있으면 전체 거부한다. Workspace는 다른 destination unfiled로 source placement를 모두 옮기고 source folders를 제거하며, default source면 destination을 같은 commit에서 새 default로 만든다. 마지막 workspace는 삭제하지 않는다. Preview는 영향 설명일 뿐 commit은 latest registry/record scan/pending finalize receipt를 다시 계산한다.

모든 canonical replace는 temp write → file fsync → rename → parent-directory fsync를 사용한다. Rename이 logical commit 지점이고 결과를 다음 네 상태로 표현한다.

- `not_committed`
- `committed_durable`
- `committed_best_effort` — directory sync가 알려진 미지원인 환경
- `committed_durability_pending` — rename은 끝났지만 지원 환경의 namespace sync가 일시 실패

Pending이면 authoritative 새 version을 유지하고 namespace sync 재시도 전 후속 registry mutation을 fail-closed한다. Best-effort는 reduced durability를 보고하되 영구적으로 ordinary mutation을 막지 않는다.

## 왜

폴더마다 meeting directory를 이동하면 recorder/finalize/transcription/summarization path와 lock identity가 동시에 바뀌어 crash recovery가 어려워진다. Stable artifact path와 중앙 placement metadata를 분리하면 조직 변경은 작은 문서 한 번의 atomic commit이 된다. 단일 사용자여도 background worker, polling, API request는 겹칠 수 있으므로 process queue와 expected token이 lost update를 막는다.

File fsync 뒤 rename만으로는 crash 직후 directory entry persistence를 보장하지 못하는 filesystem이 있다. 반대로 directory fsync 미지원 환경을 transient failure처럼 영구 차단해서도 안 된다. 네 상태는 논리적 commit과 물리적 durability를 분리한다.

## 버린 대안

- Workspace/folder별 physical directory 이동 — artifact path·writer 소유권·복구 복잡도가 커져 기각.
- Folder별 registry 파일 — cross-folder move가 multi-file transaction이 되어 기각.
- Container 삭제 시 meeting directory cascade — 조직 정리와 사용자 원본 영구 삭제를 결합하므로 기각.
- Child folder 자동 merge/rename suffix — 사용자 의도 없이 tree 의미를 바꾸므로 conflict 전체 거부를 선택.
- Post-rename sync 실패 시 rollback 또는 같은 mutation blind retry — 이미 commit된 canonical을 지우거나 중복 적용할 수 있어 기각.
- OS 이름 기반 directory-sync 지원 추측 — runtime capability/fault 결과가 더 정확해 기각.
- DB·multi-process lock — 로컬 단일 Next Node process 범위를 넘어가므로 비목표.

## 영향받는 곳

`src/domain/library.ts`, `src/lib/durableFileOps.ts`, `src/lib/library.ts`, `src/lib/atomicWrite.ts`, `src/lib/paths.ts`. ADR 0003의 single-writer 파일 소유권을 확장하며 ADR 0006의 전면적 v2 견고성 연기 중 registry에 필요한 좁은 기반만 현재 구현한다.
