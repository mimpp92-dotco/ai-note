# 0013 — Durable summarize attempt와 generation-consistent pair 발행

- **날짜:** 2026-07-10
- **상태:** 채택됨

## 무엇을 결정했나

요약 수락을 `status.summarizeAttempt` durable receipt로 기록한 뒤에만 adapter를 실행하고 202를 반환한다. `summarizeCore`는 path/I/O 없는 payload transformer로 축소하고, 단일 app publisher가 attempt 전용 hidden directory에 두 output·manifest·pre-transcript를 내구 staging한다.

Canonical 발행은 artifact write lease 안에서 `transcript.md` 먼저, completion marker인 `summary.json` 마지막 순서로 한다. 상세·export는 read lease 안에서 pair를 함께 읽고, delete/cleanup은 write lease를 사용한다. Lock 순서는 `meeting operation → artifact RW → status queue → library queue`다.

재시작 후 첫 pair read는 manifest·staged·pre/current/intended hash로 completed/resume/restore/interrupted/ambiguous를 판정한다. Ambiguous에서는 추측해 덮어쓰지 않고 pair 노출을 차단한다.

## 왜

각 파일의 atomic rename만으로는 프로세스 crash 시 `T1/S0`를 막을 수 없고, in-memory lock만으로는 재시작 후 active와 interrupted를 구분할 수 없다. Durable receipt·manifest·backup·RW lease를 결합해 어떤 crash 지점에서도 old pair, new pair, 또는 명시적 주의 상태 중 하나로만 보이게 한다.

## 버린 대안

- 두 canonical 파일을 연속 atomic replace: 두 rename 사이 crash와 concurrent reader의 mixed pair를 막지 못한다.
- 최종 pair을 하나의 directory rename으로 교체: 기존 stable meeting directory·audio/raw/status writer 소유권과 충돌한다.
- in-memory Set만 completion 신호로 사용: restart 후 정보가 사라져 interrupted를 오판한다.
- 모순 시 최신 파일을 임의 채택: 사용자 회의록을 조용히 손상시킬 수 있어 fail-closed를 선택했다.

## 영향받는 곳

- `src/lib/summarize.ts`, `summarizeCore.ts`, `summarizePublisher.ts`, `artifactLease.ts`, `artifactPair.ts`.
- 상세 RSC, export, meeting DELETE, summary-work cold-entry reconciliation.
- ADR [0002](0002-claude-command-no-app-llm.md), [0008](0008-title-override.md), [0009](0009-async-resummarize-failure-visibility.md), [0010](0010-isolated-claude-summarize-invocation.md).
