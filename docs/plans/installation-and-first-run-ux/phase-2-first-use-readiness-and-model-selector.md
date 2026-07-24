# Phase 2 — First-use readiness and model selector

## 목표

첫 화면에서 요약 설정을 발견할 수 있게 하면서 녹음과 로컬 전사는 계속 사용할 수 있게 한다. 설정 화면은 provider별로 좁고 정직한 모델 선택지를 제공하고, 저장된 설정만 자동 검사한다. Ollama 설치 모델 discovery는 기존 local ingress/egress 경계를 그대로 적용한다.

## 읽어야 할 파일

- `AGENTS.md`
- `src/CLAUDE.md`
- `docs/ARCHITECTURE.md`
- `docs/UI_GUIDE.md`
- `docs/decisions/0002-claude-command-no-app-llm.md`
- `docs/decisions/0010-isolated-claude-summarize-invocation.md`
- `docs/decisions/0012-local-ingress-and-fixed-id-service-boundary.md`
- `src/app/settings/page.tsx`
- `src/app/api/settings/llm/route.ts`
- `src/app/api/settings/llm/health/route.ts`
- `src/components/SettingsForm.tsx`
- `src/components/UserProfileForm.tsx`
- `src/components/HomeClient.tsx`
- `src/components/Recorder.tsx`
- `src/components/healthStatus.ts`
- `src/components/useHealth.ts`
- `src/lib/localEndpoint.ts`
- `src/lib/localRequestGuard.ts`
- `src/lib/publicApi.ts`
- `src/lib/settings.ts`
- `src/services/llm/types.ts`
- `src/services/llm/claudeCli.ts`
- `src/services/llm/codexCli.ts`
- `src/services/llm/ollama.ts`
- 관련 component, adapter, route integration test 파일

## 요구사항

- `R3`
- `R4`
- `R6`
- `R7`

## 허용 범위

- `src/app/settings/page.tsx`
- `src/app/api/settings/llm/health/route.ts`
- `src/app/api/settings/llm/models/route.ts`
- `src/components/SettingsForm.tsx`
- `src/components/HomeClient.tsx`
- `src/components/Recorder.tsx`
- `src/components/healthStatus.ts`
- `src/services/llm/claudeCli.ts`
- `src/services/llm/codexCli.ts`
- `src/services/llm/ollama.ts`
- `src/components/__tests__/views.test.tsx`
- `src/components/__tests__/UserProfileForm.test.tsx`
- `src/components/__tests__/LibraryNavigation.test.tsx`
- `src/components/__tests__/RecorderSessionProvider.test.tsx`
- `src/components/__tests__/healthStatus.test.ts`
- `src/services/llm/__tests__/claudeCli.test.ts`
- `src/services/llm/__tests__/codexCli.test.ts`
- `src/services/llm/__tests__/ollama.test.ts`
- `src/app/api/__tests__/routes.integration.test.ts`

## 금지 및 중단 조건

- 전역 금지 경로와 기존 summary/data ownership 계약을 유지한다.
- Claude/Codex remote model API, experimental model-list command, hard-coded versioned Codex catalog를 추가하지 않는다.
- Ollama discovery는 explicit-port `localhost|127.0.0.1` 밖으로 나가거나 redirect, unbounded body/list/name을 허용하지 않는다.
- API key, paid API, auto pull, provider login 또는 Whisper download를 추가하지 않는다.
- settings API 밖에서 `data/settings.json`을 쓰지 않는다.
- CLI health를 인증이나 실제 model generation 성공으로 표현하지 않는다.
- 새 dependency, tour framework, onboarding route 또는 blocking modal이 필요하면 중단한다.
- 허용 경로 밖 수정이 필요하면 중단한다.

## 작업

1. `SettingsForm`의 기존 load error, saved snapshot, normalized draft, dirty gating과 baseUrl 비노출 test를 보존하는 실패 test를 먼저 쓴다.
2. model control을 provider별 native `select`와 `직접 입력`일 때만 보이는 text field로 바꾼다.
   - Claude: default, sonnet, opus, haiku, custom
   - Codex: default, custom
   - Ollama: installed models, refresh, custom
3. saved unknown model은 custom option으로 열어 exact value를 유지한다. provider별 draft map을 두되 현재 provider만 save payload에 포함하고 CLI default는 model을 omit한다.
4. `POST /api/settings/llm/models`를 Ollama 전용 read/discovery surface로 추가한다.
   - guard를 body/setting/fs/fetch보다 먼저 실행
   - strict bounded `{baseUrl?}` JSON
   - existing loopback normalizer 사용
   - redirect error, short timeout, bounded raw body
   - model count/name cap, invalid entry 제거, deterministic de-duplicate
   - public response에는 model names 또는 static sanitized error만 포함
5. Ollama adapter의 tags parsing을 discovery와 health가 같은 bounded contract로 재사용하되 generation 호출과 settings writer는 바꾸지 않는다.
6. save 성공 body를 검증한 뒤 그 persisted snapshot으로 health를 자동 호출한다. 기존 수동 `연결 테스트`는 재확인 action으로 유지할 수 있으나 자동 검사와 서로 다른 snapshot을 섞지 않는다.
7. CLI success는 `감지됨`, Ollama success는 `연결됨`으로 표시하고 provider별 실패 copy를 한국어의 실행 가능한 안내로 제한한다.
8. settings page에서 `요약 모델`을 먼저, 선택적인 `내 정보`를 다음에 렌더한다.
9. 홈 recorder 앞에 unconfigured/unavailable readiness card를 넣고 설정 이동과 recorder focus action을 제공한다. loading 중에는 경고를 먼저 보여 주지 않는다.
10. recorder 시작 label을 `회의 녹음 시작`으로 바꾸고 첫 전사의 model download 가능성을 first-use copy에 포함한다.

## 테스트 (먼저 작성)

- RTL은 first-use card의 조건, 설정/recorder focus, 44px controls, settings order와 녹음 비차단을 검증한다.
- Settings test는 provider별 option/value, default omission, unknown/custom 보존, provider draft 격리, Ollama refresh, save 후 persisted health, load/save/discovery error의 draft 보존을 검증한다.
- Route integration은 guard-before-body/network, exact JSON cap, unsafe/non-explicit/redirect endpoint 거부, timeout, oversized/malformed tags, sanitized response를 검증한다.
- Adapter test는 CLI 감지 표현과 Ollama exact model membership을 실제 binary/network 없이 검증한다.

## 문서 최신화

Settings, first-use와 local discovery 정본은 Phase 5에서 갱신한다. 이 phase의 user-facing copy는 raw provider/fs output이나 `best-effort` 용어를 노출하지 않는다.

## 완료 게이트

```bash
npm test -- src/components/__tests__/views.test.tsx src/components/__tests__/UserProfileForm.test.tsx src/components/__tests__/LibraryNavigation.test.tsx src/components/__tests__/RecorderSessionProvider.test.tsx src/components/__tests__/healthStatus.test.ts src/services/llm/__tests__/claudeCli.test.ts src/services/llm/__tests__/codexCli.test.ts src/services/llm/__tests__/ollama.test.ts src/app/api/__tests__/routes.integration.test.ts
npm run typecheck
```
