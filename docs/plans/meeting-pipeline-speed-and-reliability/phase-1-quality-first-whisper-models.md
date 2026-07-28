# Phase 1 — 품질 우선 Whisper 모델 선택과 준비

## 읽어야 할 파일

Fresh session은 루트·`src`·`whisper` 지침, architecture/PRD/UI guide, local ingress와 durable transcription ADR을 먼저 읽는다. 이어 현재 pipeline settings가 없는 상태, Whisper client/health, transcription claim parser, settings page, Python service와 그 contract test를 읽는다. 정확한 read set은 `plan.json`이 정본이다.

## 요구사항

- R2: `large-v3` 품질 우선 default, `large-v3-turbo` 선택, 저장과 prepare 분리, dispatch model snapshot을 구현한다.
- R7: 새 설정 UX를 synthetic browser scenario에 미리 고정하고 기존 local-only 경계를 보존한다.

## 허용 범위

새 app-owned pipeline settings module/API/form, Whisper prepare proxy/client, fixed Python model catalog, service claim/health/prepare 처리와 직접 관련 test만 수정한다. 기존 installation Playwright spec에는 synthetic route와 assertion만 추가한다. 기계 경로 정본은 `plan.json`이다.

## 금지 및 중단 조건

- `large-v3`를 기본값에서 내리거나 실제 benchmark 없이 Turbo를 권장으로 표시하지 않는다.
- Browser request나 `/transcribe`가 repo/path를 전달하지 않는다. `/transcribe` body는 계속 exact `{meetingId,dispatchId}`다.
- 설정 저장 side effect로 download/load를 시작하지 않는다.
- 같은 accepted dispatch의 partial publication을 다른 model로 이어 쓰지 않는다.
- Test에서 실제 model/audio/network를 사용하지 않는다.
- Dependency·lockfile·canonical meeting data·허용 범위 밖 변경이 필요하면 중단한다.

## 작업

1. `data/pipeline-settings.json`의 strict v1 shape와 app-api single-writer repository를 RED test로 정의한다.
   - Missing file은 `{transcription.model:"large-v3", correction.mode:"full"}`과 동등한 default다.
   - Corrupt/unsupported stored value는 임의 sanitize하지 않고 UI/API에 안전한 unavailable 상태를 낸다.
   - 저장은 existing atomic durable writer를 사용하며 LLM `data/settings.json`과 합치지 않는다.
2. Settings 화면에 별도 “전사·교정” section을 추가한다.
   - Whisper select는 `large-v3 — 품질 우선(기본)`과 `large-v3-turbo — 더 빠른 후보` 두 개뿐이다.
   - 저장, model 준비, 준비 상태를 별도 control/state로 둔다.
   - 저장 직후 prepare request가 한 번도 발생하지 않음을 component/API test로 증명한다.
3. App→Whisper prepare 경로를 추가한다.
   - App route는 local request guard와 bounded strict JSON을 먼저 적용한다.
   - Fixed enum model만 service에 전달하고 redirect를 금지한다.
   - Whisper service는 202 async prepare와 bounded in-memory state를 제공한다. 진행·완료·실패 메시지는 path/repo/provider raw error를 내보내지 않는다.
4. Python fixed model catalog를 만든다.
   - MLX repo는 승인된 두 값을 exact mapping한다.
   - faster-whisper logical model도 같은 선택을 사용한다.
   - 기존 `LOCAL_STT_MODEL`/`LOCAL_STT_MLX_REPO`는 stored pipeline setting이 없을 때만 legacy startup default로 읽는다. 기존 `base`/`small` startup 사용은 호환하되 UI catalog에 노출하지 않는다.
5. Claim schema v2에 accepted model identity를 넣고 v1을 계속 읽는다.
   - Claim create-exclusive 순간의 effective model을 snapshot한다.
   - Existing claim resume는 current setting을 다시 읽어 model을 바꾸지 않는다.
   - App completion inspector는 v1/v2 모두 strict하게 확인하되 v2 model metadata를 public DTO로 내보내지 않는다.
6. Prepare와 actual inference가 공유하는 global single-execution fence를 추가한다.
   - Per-meeting lock, job identity, segments-first/raw-last, durability 상태는 그대로다.
   - 한 model 작업 실패가 다른 meeting의 claim을 advance하지 않는다.
7. Health DTO를 확장하되 `ready`는 계속 service+ffmpeg readiness다. Model download 여부 때문에 bootstrap이 설치 실패가 되지 않게 model prepare 상태는 별도 필드로 둔다.

## 테스트 (먼저 작성)

- Settings missing/default, strict round-trip, corrupt/unknown, atomic write와 concurrent save behavior.
- Save-no-download, explicit prepare one-shot, stale prepare response 무시, safe failure, 320px control 구조.
- Whisper catalog exact mapping, async prepare, global fence, model failure, no raw error.
- Claim v1 read, v2 create/resume, setting switch after acceptance, same dispatch retry, raw-last publication.
- Client/proxy malformed DTO, redirect/non-loopback/unknown model rejection.
- 모든 Python/model call은 fake injection이며 network와 cache를 건드리지 않는다.

## 문서 최신화

이 phase에서는 제품 정본 문서를 수정하지 않는다. E2E spec에는 구현할 synthetic scenario만 추가하고, 최종 표현과 ADR은 Phase 5에서 검증된 동작에 맞춘다.

## 완료 게이트

저장소 루트에서 실행한다.

```bash
npm test -- whisper/__tests__/server.contract.test.ts src/services/__tests__/whisperClient.test.ts src/lib/__tests__/pipelineSettings.test.ts src/lib/__tests__/transcriptionArtifacts.test.ts src/lib/__tests__/publicApi.test.ts src/app/api/__tests__/routes.integration.test.ts src/components/__tests__/PipelineSettingsForm.test.tsx src/components/__tests__/healthStatus.test.ts src/components/__tests__/useHealth.test.tsx
npm run typecheck
```
