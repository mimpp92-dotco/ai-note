# 0024 — 품질 우선 meeting pipeline과 증거 기반 fast 선택

- **날짜:** 2026-07-28
- **상태:** 채택됨

## 무엇을 결정했나

### 품질 우선 default와 model identity

Pipeline settings는 `data/pipeline-settings.json` 한 atomic document에 fixed
Whisper model과 correction mode를 함께 저장한다. 선택지는
`large-v3|large-v3-turbo`, `full|fast`뿐이고 missing/legacy settings는
`large-v3`+`full`이다. Turbo와 fast는 후보/실험 상태이며 실제 동일 회의
비교와 사람 품질 검수 전에는 추천하거나 default로 바꾸지 않는다.

Model 저장은 download/load를 시작하지 않는다. 사용자가 별도 prepare를
명시하거나 첫 실제 전사가 lazy download를 시작한다. Prepare와 inference는
Whisper process-global execution fence 하나를 공유한다. 새 transcription
claim v2는 acceptance 시 logical model, MLX repo와 faster-whisper model을
snapshot한다. 이미 accepted/processing인 dispatch와 같은 dispatch의 수동
resume는 이후 settings 변경과 무관하게 그 snapshot을 계속 쓴다. Stored
pipeline settings가 없을 때만 기존 `LOCAL_STT_MODEL`/`LOCAL_STT_MLX_REPO`를
legacy startup source로 사용하고 schema-v1 claim과 claim-less raw를 읽는다.

### Manual retry와 correction checkpoint

Finalize 뒤 최초 transcription과 최초 correction/summary dispatch는 계속
자동이다. 한 번 명시적으로 실패한 작업은 worker poll, network 복귀, app
restart만으로 새 attempt를 만들지 않는다. 기존 artifact와 safe error를
보여 주고 사용자의 수동 retry 접수만 다시 시작한다. Auto reconnect/resume,
watchdog, supervisor restart/autostart와 browser stage-progress UI는 만들지
않는다.

Full/fast correction은 meeting 내부 hidden
`.correction-checkpoint.json`에 exact source/config identity와 validated
result를 durable replace한다. Full은 correction guard를 통과한 transcript를
summary 전에 commit하고, fast는 valid chunk마다 동일 checkpoint를
갱신한다. Raw/glossary/provider/model/normalized endpoint/prompt
version/mode/chunk plan이 모두 일치하는 manual retry만 full correction 또는
completed chunks를 재사용한다. Summary failure/process interruption은
checkpoint를 보존하고 canonical pair publication 성공 뒤에만 best-effort
삭제한다.

Fast planner는 immutable segment/raw natural boundary와 deterministic
oversized split을 사용한다. Context는 read-only이고 target output에 섞지
않는다. Claude/Codex correction concurrency는 최대 2, Ollama는 1이다.
Chunk/merge guard가 누락·중복·순서 변경·empty·과도한 길이·script/context
contamination을 거부한다. 첫 failure 뒤 새 chunk나 full fallback을 자동
시작하지 않고 모든 chunk가 valid한 뒤 summary를 한 번만 실행한다.

### Structured provider isolation과 긴 회의

Summary caller만 generated-summary strict JSON Schema를 adapter에 전달하고
chat tool loop는 generic JSON envelope를 유지한다. Claude/Codex optional
flag는 process-level bounded help probe로 generation 전에만 결정한다.
Claude는 OAuth/keychain을 유지하는 safe/tools/session/browser-off 격리와
기존 temp cwd/MCP/slash/$0 env scrub을 사용하며 `--bare`를 쓰지 않는다.
Codex는 지원되는 ephemeral/user-config/rules-off, read-only temp cwd,
schema와 bounded last-message file을 사용한다. Ollama는 schema object를
`format`으로 보낸다.

Capability probe failure는 known-safe one-call path로 내려가고 generation이
시작된 뒤 unsupported optional flag 때문에 같은 prompt를 재실행하지
않는다. Fenced/prose/wrapper JSON salvage와 final schema validation/fallback은
남긴다. Prompt/transcript/raw output/temp output은 argv, public response,
generic log에 넣지 않는다. Call당 generation timeout은 30분이다. Full
correction은 transcript 전체를 보내고 실제로 자르지 않았던 40,000자
notice와 truncated result를 제거한다. 실제 context/timeout failure는
checkpoint를 보존한 visible manual-retry error다. Summary map-reduce는
계속 비목표다.

### Explicit real-data benchmark와 synthetic QA

Real comparison은 사용자가 exact meeting ID와 실제
audio/transcript/glossary/configured provider 사용을 승인한
`npm run benchmark:pipeline -- --meeting-id <id>`로만 시작한다. Source
meeting은 read-only이며 mode-0700 `.ai-note-runtime/benchmarks/<run-id>/`
snapshot만 writer target이다. Large-v3/Turbo와 full/fast output, hashes,
stage wall time, logical identity와 human-review template를 남기고 source
status/library/canonical artifacts/tombstone/dispatch/publisher를 수정하지
않는다. Terminal에는 safe status와 run directory만 출력한다.

Turbo는 중요 이름·숫자·결정 오류 증가 0과 2× 이상 speedup, fast는 같은
품질 조건과 full 대비 30% 이상 단축이 모두 필요하다. 사람이 review를
완료하지 않으면 recommendation은 `undecided`다. Unit/final gate/Playwright와
ordinary startup은 실제 data/provider/model/network를 사용하지 않고
synthetic placeholder와 injected boundary만 사용한다.

## 왜

Quality-first default를 유지하면서도 느린 실제 회의의 병목을 비교하려면
model/mode 선택이 dispatch와 crash boundary를 넘어 재현 가능해야 한다.
Settings만 읽는 방식은 처리 중 model이 바뀌고, in-memory correction만
두는 방식은 summary failure 뒤 동일한 긴 correction을 반복한다. Claim
snapshot과 durable checkpoint가 이 두 identity를 local filesystem에서
고정한다.

Optional CLI flag를 generation failure/retry로 탐지하면 같은 민감 prompt를
중복 전송하고 wall time과 비용 경계를 흐린다. Bounded help capability와
one generation call이 더 정직하다. Static generated-summary schema는 provider
output을 강화하지만 tolerant parser와 final validation을 제거할 이유는
없다.

Turbo/fast 구현만으로 품질을 증명할 수 없다. 실제 source를 수정하는
benchmark나 transcript를 terminal/Git에 남기는 비교도 local-first 경계를
훼손한다. Explicit private snapshot, objective threshold와 별도 사람 review를
결합해 recommendation을 evidence 뒤로 미룬다.

## 버린 대안

- `large-v3-turbo` 또는 fast를 구현 즉시 default/권장으로 승격 — 실제
  중요 정보 정확도 evidence가 없어 기각.
- Settings save 시 model download/load — persistence와 고비용 network/model
  작업을 결합하고 save UX를 오래 막아 기각.
- Processing 때마다 current model settings 읽기 — same dispatch retry가 다른
  model로 바뀌어 기각.
- Failure 뒤 worker auto retry/reconnect resume/full fallback — 중복 provider
  work와 실패 원인 은폐를 만들어 기각.
- Fast chunk context까지 merge하거나 failure chunk를 raw로 대체 — target
  coverage와 성공 의미를 거짓으로 만들어 기각.
- Unsupported CLI flag를 실제 generation 실패 후 prompt 재실행으로 탐지 —
  same prompt를 중복 전송해 기각.
- Claude `--bare`, direct paid API/API key 저장 — subscription OAuth와 $0
  원칙을 깨므로 기각.
- 40,000자에서 transcript를 truncate하거나 notice만 유지 — 실제 input과
  결과 설명이 어긋나므로 기각.
- Benchmark가 latest meeting을 추측하거나 canonical source를 writer
  target으로 사용 — 원본 불가침과 explicit consent를 깨므로 기각.
- 자동 metric만으로 품질 합격 — 중요 이름·숫자·결정 의미를 증명하지
  못해 기각.

## 영향받는 곳

- Pipeline/model: `data/pipeline-settings.json`,
  `src/lib/pipelineSettings.ts`, Settings 전사·교정 section,
  `whisper/model_catalog.py`, `whisper/server.py`,
  `.whisper-dispatch.json`.
- Correction/retry: `src/lib/correctionChunks.ts`,
  `src/lib/correctionRunner.ts`, `src/lib/summarizeCheckpoint.ts`,
  `src/lib/summarize.ts`, meeting `.correction-checkpoint.json`.
- Provider: generated summary schema, LLM adapter options/capability detector,
  Claude/Codex/Ollama adapters, 30-minute generation timeout.
- Benchmark/QA: `scripts/meeting-pipeline-benchmark.mjs`,
  `whisper/benchmark.py`, private `.ai-note-runtime/benchmarks/`, synthetic
  unit/component/Playwright scenarios.

이 ADR은 [0001](0001-local-whisper-batch.md)의 “fixed-only
mlx large-v3” 부분을 fixed two-model quality-first catalog로 부분 대체한다.
[0009](0009-async-resummarize-failure-visibility.md)와
[0010](0010-isolated-claude-summarize-invocation.md)의 600초 및 과거 CLI
invocation 상세만 30분/capability-gated structured isolation으로 부분
대체한다. Local batch/no realtime, 202와 visible failure, OAuth/$0 env scrub
결정은 유지한다.

[0012](0012-local-ingress-and-fixed-id-service-boundary.md)의 ingress/fixed-ID,
[0013](0013-durable-summarize-pair-publication.md)의 canonical pair publisher와
lock order, [0014](0014-durable-transcription-dispatch.md)의 raw-last durable
identity, [0020](0020-deterministic-synthetic-browser-verification.md)의
synthetic-only gate, [0023](0023-installation-and-first-run-ux.md)의 owned
runtime/first-run 경계는 대체하지 않고 그대로 따른다. Tombstone과 library
single-writer 경계도 변경하지 않는다.
