# Phase 4 — 선택형 빠른 교정과 격리 벤치마크

## 읽어야 할 파일

Fresh session은 Phase 1~3이 만든 pipeline settings, checkpoint, structured adapters와 기존 immutable transcription/publisher 계약을 읽는다. 이어 scripts runtime/snapshot 패턴, benchmark 대상 Python model catalog/service, component/E2E tests와 synthetic browser ADR을 읽는다. 정확한 목록은 `plan.json`이 정본이다.

## 요구사항

- R3: Fast mode도 chunk별 durable checkpoint와 exact-key manual resume를 사용한다.
- R5: Full default를 유지하면서 deterministic chunk/제한 병렬 fast correction을 구현한다.
- R6: 실제 회의를 원본 변경 없이 비교하는 explicit isolated benchmark command를 제공한다.

## 허용 범위

Pipeline setting의 correction mode, chunk planner/runner/checkpoint integration, settings form, benchmark orchestrator/Python helper/package script, 관련 unit/component/contract/E2E spec만 수정한다. 실제 data나 benchmark output은 plan 실행 중 생성하지 않는다.

## 금지 및 중단 조건

- Full mode를 default에서 내리거나 benchmark 전 fast를 권장으로 표시하지 않는다.
- Chunk merge에서 target 누락·중복·재정렬 또는 overlap 출력 혼입을 허용하지 않는다.
- Claude/Codex 2, Ollama 1보다 높은 동시성을 사용하지 않는다.
- Chunk failure 뒤 남은 새 work 또는 full fallback을 자동 실행하지 않는다.
- Benchmark가 meeting ID를 추측하거나 original status/library/artifact를 수정하지 않는다.
- Automated test에서 실제 meeting/provider/model/network를 사용하지 않는다.
- Dependency, lockfile, real fixture 또는 허용 범위 밖 변경이 필요하면 중단한다.

## 작업

1. Pipeline setting에 `correction.mode: "full" | "fast"`를 strict하게 추가한다.
   - Missing/legacy settings는 `full`이다.
   - UI는 full을 “품질 우선(기본)”, fast를 “실험적·검증 필요”로 표현한다.
   - Model setting과 correction setting은 한 atomic document에서 저장해 서로를 clobber하지 않는다.
2. Pure deterministic chunk planner를 RED test로 만든다.
   - Immutable segments/raw line의 자연 경계에서 target range를 나눈다.
   - Target size와 hard cap은 code-owned constants로 두고, 단일 segment가 hard cap을 넘을 때만 deterministic safe text boundary를 사용한다.
   - 각 chunk는 stable ID, target hash/range, read-only preceding/following context를 가진다.
   - 전체 plan은 every source target exactly once, stable order와 plan hash를 검증한다.
3. Bounded correction runner를 만든다.
   - Claude/Codex semaphore 2, Ollama semaphore 1.
   - Prompt는 context와 target을 명확히 구분하고 target correction만 출력하게 한다.
   - 각 result에 empty, length ratio, script contamination과 target coverage sanity를 적용한다.
   - 결과는 source order로만 merge하며 paragraph separator를 deterministic하게 보존한다.
4. Phase 2 checkpoint를 chunk-aware로 확장한다.
   - Plan hash와 chunk identity가 맞는 completed result만 재사용한다.
   - Chunk 성공마다 single JSON을 durable replace한다.
   - Failure 시 이미 commit된 chunks를 보존하고 새 chunk scheduling을 중단한다.
   - 모든 chunk가 valid해야 merged transcript checkpoint를 만들고 summary를 정확히 한 번 실행한다.
5. Explicit `npm run benchmark:pipeline -- --meeting-id <id>` black-box harness를 만든다.
   - Exact safe meeting ID를 필수로 받고 `latest`나 directory path를 받지 않는다.
   - Original meeting/audio/raw/segments/glossary/settings를 read-only로 확인한 뒤 mode-0700 `.ai-note-runtime/benchmarks/<run-id>/` snapshot에 필요한 것만 복사한다.
   - Repository-owned process/snapshot pattern으로 isolated Whisper/app/provider runs를 수행하고 original data root를 writer target으로 사용하지 않는다.
   - large-v3/large-v3-turbo 전사와 full/fast 교정 결과를 별도 run에 생성한다. Source canonical pair, status, library와 tombstone을 호출하거나 갱신하지 않는다.
   - SIGINT/timeout/failure에서 child를 정리하고 failed snapshot은 자동 재실행하지 않는다.
6. Benchmark report를 만든다.
   - Stage wall time, source/output SHA-256, logical model/provider/mode, speed ratios와 threshold result를 JSON에 기록한다.
   - 사람이 오디오·결과를 대조할 중요 이름·숫자·결정 checklist를 Markdown으로 만든다.
   - Human review가 비어 있으면 recommendation은 `undecided`; 자동 extraction으로 품질 합격을 꾸미지 않는다.
   - Terminal에는 run directory와 safe status만 출력하고 transcript/audio/provider output을 출력하지 않는다.
7. Benchmark orchestration test는 injected filesystem/process/fetch/clock과 synthetic text/audio placeholder만 사용한다. Test가 `.ai-note-runtime` real path, data, model cache나 network를 건드리지 않게 한다.

## 테스트 (먼저 작성)

- Chunk boundary, oversized segment, Unicode, empty lines, stable IDs/hash, every-target-exactly-once.
- Out-of-order completion 뒤 stable merge, concurrency max 2/1, first failure scheduling stop.
- Per-chunk checkpoint resume, key/plan mismatch, corruption, full-mode no chunk call.
- Settings legacy/full default, fast explicit save, stale response와 accessible control.
- Benchmark exact-ID/path rejection, source read-only, isolated root, safe process env, cleanup, no transcript logging.
- Threshold calculation은 synthetic durations/review fixture로만 검사한다.
- Python benchmark helper는 fake model adapter만 사용해 fixed catalog와 output fence를 검사한다.

## 문서 최신화

Benchmark command와 privacy warning은 Phase 5에서 구현과 대조해 문서화한다. E2E spec에는 synthetic settings/prepare/fast-mode assertion만 추가하고 실제 benchmark는 넣지 않는다.

## 완료 게이트

저장소 루트에서 실행한다.

```bash
npm test -- src/lib/__tests__/pipelineSettings.test.ts src/lib/__tests__/correctionChunks.test.ts src/lib/__tests__/correctionRunner.test.ts src/lib/__tests__/summarizeCheckpoint.test.ts src/lib/__tests__/summarize.test.ts src/components/__tests__/PipelineSettingsForm.test.tsx scripts/__tests__/meeting-pipeline-benchmark.test.mjs whisper/__tests__/server.contract.test.ts
npm run typecheck
```
