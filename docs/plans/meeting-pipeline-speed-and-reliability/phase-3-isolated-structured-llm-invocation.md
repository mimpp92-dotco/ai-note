# Phase 3 — 격리된 구조화 LLM 호출

## 읽어야 할 파일

Fresh session은 $0/local CLI 원칙과 Claude isolation/timeout ADR, generated summary schema, chat JSON envelope, summarize core/prompt, 각 adapter와 process wrapper/test를 읽는다. 설치된 특정 버전을 상수로 믿지 말고 repository contract와 capability behavior를 구현 기준으로 삼는다.

## 요구사항

- R4: 지원 가능한 structured output과 더 강한 CLI 격리를 한 번의 generation 호출에 적용하고, 거짓 40,000자 경고를 제거한다.

## 허용 범위

Generated-summary JSON Schema 정본, adapter option/capability helper, Claude/Codex/Ollama/Fake adapter, summarize/chat caller와 parsing/prompt test만 변경한다. Manual summary schema와 canonical publisher는 수정하지 않는다.

## 금지 및 중단 조건

- Claude OAuth를 잃게 하는 `--bare`, API key 또는 paid backend를 사용하지 않는다.
- Unsupported optional flag를 실제 generation 실패로 알아낸 뒤 같은 prompt를 자동 재호출하지 않는다.
- Structured output 때문에 tolerant parser나 final Zod validation을 제거하지 않는다.
- 40,000자 경고 대신 실제 transcript를 몰래 자르지 않는다.
- Transcript/prompt/schema output을 argv, public error, generic log에 노출하지 않는다.
- 새 dependency 또는 허용 범위 밖 변경이 필요하면 중단한다.

## 작업

1. Generated structured summary만을 위한 static strict JSON Schema를 만든다.
   - Generated mode는 manual `body`를 만들지 않는다.
   - Required structured fields와 action item shape는 current prompt/parser output에 맞춘다.
   - Model participants는 canonical source가 아니므로 schema/prompt가 status.review ownership을 바꾸지 않는다.
   - Unit test가 static schema와 accepted generated shape의 필수 field/type/additionalProperties 계약을 함께 고정한다.
2. `LlmAdapter.run` option을 generic JSON hint와 explicit JSON Schema로 구분한다.
   - Chat envelope는 기존 generic JSON 경로를 사용한다.
   - Summary caller만 generated-summary schema를 넘긴다.
3. Bounded CLI capability detector를 추가한다.
   - `--help` output을 process당 cache하고 timeout/output cap을 둔다.
   - Probe 실패는 generation을 이중 실행하지 않고 기존 known-safe argument set으로 내려간다.
   - Transcript나 prompt를 probe에 전달하지 않는다.
4. Claude invocation을 강화한다.
   - 지원 시 `--safe-mode`, `--no-session-persistence`, `--tools ""`, `--no-chrome`와 JSON schema를 사용한다.
   - Existing temp cwd, strict empty MCP, slash off, stdin prompt, paid-billing env scrub을 유지한다.
   - `--bare`는 사용하지 않는다.
5. Codex invocation을 강화한다.
   - 지원 시 `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--output-schema`, `--output-last-message`, color-off를 사용한다.
   - Schema와 last-message file은 invocation별 mode-0700 temp directory에 두고 bounded no-follow read 뒤 cleanup한다.
   - Last-message 기능이 없으면 기존 JSONL final-message salvage를 한 번의 call fallback으로 유지한다.
6. Ollama summary request의 `format`에 JSON Schema object를 전달한다. Generic JSON은 기존 `"json"`을 유지하고 redirect/loopback/timeout 경계를 바꾸지 않는다.
7. `summarizeCore`의 `MAX_TRANSCRIPT_CHARS`, false notice와 `truncated` return을 제거한다.
   - Full transcript를 prompt에 넣는 현재 behavior를 명시적으로 test한다.
   - 실제 context/timeout error는 adapter failure로 전파돼 Phase 2 checkpoint와 manual retry를 사용한다.

## 테스트 (먼저 작성)

- Generated schema valid/invalid/additional property/manual body/participant ownership.
- Capability help supported/unsupported/timeout/malformed/cache와 generation exactly-once.
- Claude exact args, OAuth-preserving safe mode, temp cwd, tools/MCP/session off, env scrub, cleanup.
- Codex schema/last-message bounded read, old CLI JSONL fallback, malformed output, cleanup.
- Ollama schema object vs generic JSON, loopback/redirect/timeout.
- 40,001자 transcript가 잘리지 않고 false followup/truncated field를 만들지 않음.
- Chat generic JSON behavior와 summary fallback parser 회귀.

## 문서 최신화

Timeout과 isolation의 최종 정본·ADR 갱신은 Phase 5에서 수행한다. 이 phase에서는 실제 argument와 보안 의도를 설명하는 근접 주석만 변경한다.

## 완료 게이트

저장소 루트에서 실행한다.

```bash
npm test -- src/domain/__tests__/generatedSummaryJsonSchema.test.ts src/services/llm/__tests__/cliCapabilities.test.ts src/services/llm/__tests__/claudeCli.test.ts src/services/llm/__tests__/codexCli.test.ts src/services/llm/__tests__/ollama.test.ts src/services/llm/__tests__/fake.test.ts src/lib/__tests__/summarizeCore.test.ts src/lib/__tests__/summarizePrompts.test.ts src/lib/__tests__/summarize.test.ts src/lib/__tests__/chatOrchestrator.test.ts
npm run typecheck
```
