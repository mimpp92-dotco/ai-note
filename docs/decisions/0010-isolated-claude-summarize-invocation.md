# 0010 — claude 요약 호출 격리 (cwd·MCP-off·$0 env 스크럽)

- **날짜:** 2026-07-10
- **상태:** 채택됨 (ADR [0002](0002-claude-command-no-app-llm.md)의 정제 — 불변식은 그대로, 호출 방식만 구체화)

## 무엇을 결정했나

claude 요약 생성 호출(`src/services/llm/claudeCli.ts`의 `run()`)을 "단순·자기완결 작업"에 맞게 격리한다:

- **격리 cwd**: `os.tmpdir()`에서 실행(codex의 `-C tmpdir()` 패턴과 정렬). 프로젝트 디렉토리에서 돌지 않는다.
- **인라인 MCP-off**: `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`(임시파일 없이 인라인 JSON).
- **slash-off**: `--disable-slash-commands`.
- **$0 env 스크럽**: 자식 env에서 `ANTHROPIC_API_KEY`·`OPENAI_API_KEY`를 제거. `HOME`·`PATH`는 유지.
- **생성 타임아웃 600초**: ADR [0009](0009-async-resummarize-failure-visibility.md)에서 이미 도입한 `LLM_GENERATION_TIMEOUT_MS`를 그대로 쓴다(이 ADR에서 재정의하지 않는다).

전사(PII)는 지금처럼 **stdin으로만** 전달한다(argv 금지). 프롬프트·`summary.json` 스키마·`summarizeCore` 계약은 불변.

## 왜

- **오염버그 제거**: cwd가 프로젝트 디렉토리면 워크스페이스 `CLAUDE.md`/MCP 컨텍스트가 로딩돼 교정 출력에 시스템 컨텍스트가 섞였다(과거 디버깅에서 관측). tmpdir에서 실행하면 이 오염이 사라진다 — 실측: 신뢰된 적 없는 tmpdir에서 실제 교정 프롬프트가 trust-stall 없이 exit 0으로 완주했고 출력이 순수 교정문이었다(전역 `~/.claude/CLAUDE.md`가 로딩돼도 교정 출력을 오염시키지 않음). MCP/slash off는 속도가 아니라 정합·깨끗한 teardown(SIGKILL 시 손자 프로세스 최소화)·외부 접촉 축소 목적.
- **$0 코드 보장**: `exec.ts`는 `process.env`를 자식에 통째 상속한다. 사용자 셸에 유료 `ANTHROPIC_API_KEY`가 있으면 격리 claude가 구독 OAuth 대신 유료 API로 미터링될 수 있다. env 스크럽으로 코드가 이를 막는다. OAuth·keychain은 env가 아니므로(`$HOME`만 있으면 접근) 스크럽에 영향받지 않는다. **자격증명을 파일로 복사·기록하지 않는다(레드라인).**

## 버린 대안

- **`--bare`**: 전역 플러그인/훅을 벗겨 콜드 스타트를 줄이는 대안. **기각** — `--bare`는 OAuth·keychain을 읽지 않고 API 키를 강제하므로 $0 원칙 위배(유료). 실측에서도 미로그인 메시지를 stdout으로 출력하며 exit 1.
- **전용 config-dir 스파이크**(전역 플러그인/훅을 벗기되 OAuth는 유지 가능성 검증): 이번 스코프 밖. claude가 계속 느리면 후속 검토.
- **현행 유지**(프로젝트 cwd·env 통째 상속): 오염버그와 유료-미터링 리스크가 남아 기각.
- **전역 기계장치 콜드 스타트(~100s+) 자체 해결**: 의도적으로 놔둔다(무위험 코어) — 600초 타임아웃으로 "느려도 성공"을 확보한다.

## 영향받는 곳

- `src/services/llm/claudeCli.ts` — `run()` 격리(args·cwd·env).
- `src/services/llm/exec.ts` — `cwd`/`env` 배선은 이미 존재(변경 없음). 미로그인 이유 노출을 위한 stdout-꼬리 에러는 별도(honest-health 작업).
