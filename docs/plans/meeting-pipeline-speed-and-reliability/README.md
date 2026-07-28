# 회의 처리 속도·안정성 개선 계획

## 배경

사용 흐름은 “회의 종료 → 종료 버튼 → 노트북을 바로 덮고 이동”이다. 따라서 Wi‑Fi 단절과 sleep을 정상 환경으로 봐야 한다. 다만 사용자는 실패 뒤 자동 재연결·자동 재개를 원하지 않으며, 나중에 직접 재시도하는 단순한 복구를 선호한다.

현재 로컬 기록을 내용 없이 시간만 대조하면 최근 106분 회의는 전사 완료 뒤 앱이 다시 실행될 때까지 약 410분 대기했고, 실제 AI 교정·요약은 약 13분이었다. 다른 58~106분 회의의 Whisper 전사는 대략 6.5~15분 범위였다. 즉 이번 사례의 가장 큰 지연은 모델 계산보다 노트북이 닫힌 동안 runtime이 없었던 시간이며, 코드가 해결할 핵심은 다음 세 가지다.

1. 실제 계산 구간은 더 빠르게 만들되 품질 우선 기본값을 유지한다.
2. 교정까지 성공한 일을 요약 실패 때문에 반복하지 않는다.
3. 실패를 자동 retry로 숨기지 않고 정확한 수동 재시도 지점으로 남긴다.

## 합의된 요구사항

- 최초 전사와 최초 AI 처리는 자동 시작한다. 한 번 실패·중단되면 background worker가 다시 시작하지 않고 사용자가 상세 화면에서 수동 재시도한다.
- Whisper 기본값은 `large-v3`다. UI에서 `large-v3-turbo`를 고를 수 있지만 실제 동일 오디오 품질·속도 검증 전에는 기본값이나 권장 표시를 바꾸지 않는다.
- Whisper 설정 저장과 model download를 분리한다. 사용자가 누른 `모델 미리 준비`만 download/prepare를 시작한다.
- 새 전사 dispatch는 선택 model을 claim에 고정한다. 진행 중인 작업과 같은 dispatch의 retry는 설정 변경에 흔들리지 않는다.
- AI 교정 성공 직후 durable checkpoint를 남긴다. 같은 raw·glossary·provider/model·prompt·mode의 수동 재시도는 교정을 다시 하지 않고 요약부터 계속한다.
- Claude/Codex/Ollama summary 호출은 지원되는 structured-output schema를 사용하되, 오래된 CLI에서는 한 번의 기존 호출과 tolerant parser로 안전하게 내려간다.
- full-context 교정이 기본이다. deterministic chunk와 제한 병렬을 쓰는 fast correction은 기본 비활성의 명시적 실험 옵션이다.
- 실제 회의 비교는 원본을 수정하지 않는 격리 benchmark command로만 수행한다. 자동 test와 Playwright는 항상 synthetic/fake다.
- `app:status`가 살아 있는 Whisper를 `403/not_ready`로 오진하는 `127.0.0.1` Host 문제도 함께 고친다.

## 40,000자 제한과 청킹의 정확한 의미

현재 `40,000`자는 실제 입력 절단 한도가 아니다. 코드는 전체 transcript를 provider에 보내면서 길이만 검사한 뒤 “앞부분만 반영됐다”는 경고를 summary에 넣는다. 따라서 이 경고는 사실과 다르며 제거한다. full mode에서는 계속 전체 transcript를 보낸다. provider context나 30분 timeout을 실제로 넘으면 성공처럼 꾸미지 않고 실패와 재시도 checkpoint를 남긴다.

fast correction의 청킹은 긴 교정문을 여러 자연 경계로 나누는 선택형 실행 방식이다. Claude/Codex는 최대 두 chunk만 동시에 처리하고 Ollama는 한 번에 하나만 처리한다. 각 chunk는 자기 target만 출력하고, 앞뒤 문맥은 읽기 참고로만 제공한다. 결과는 원문 순서대로 합치며 누락·중복을 검증한다. Summary map-reduce는 이번 범위가 아니다.

## 품질·성능 판단 기준

| 비교 | 품질 gate | 속도 gate | 이 계획의 기본 동작 |
| --- | --- | --- | --- |
| `large-v3` vs `large-v3-turbo` | 중요 이름·숫자·결정 오류 증가 0 | Turbo가 2배 이상 빠름 | `large-v3` 유지 |
| full vs fast correction | 중요 이름·숫자·결정 오류 증가 0 | fast가 30% 이상 단축 | full 유지 |

Benchmark report만으로 품질을 자동 판정하지 않는다. 같은 실제 회의를 듣고 보는 사람 검수 결과까지 있어야 권장 후보가 된다. 그 결과로 default/권장 문구를 바꿀지는 사용자에게 다시 승인받는다.

## 하지 않을 일

- sleep/network 복귀 감지, 자동 retry, 자동 resume, stale watchdog, 자동 queue
- supervisor 자동 재시작, OS 로그인 자동 실행
- 처리 단계별 progress UI 또는 완료를 계속 지켜보게 하는 UX
- summary map-reduce, 실시간 전사, 클라우드 STT
- 별도 `Controller is already closed` 녹음 오류 수정
- API key 저장, 유료 API 직접 호출, 실제 회의가 들어간 자동 test/browser fixture
- canonical `audio.webm`, `raw.md`, `segments.json` 수정
- 전체 설정 화면 또는 제품 UI redesign

## 핵심 설계 경계

- 새 `data/pipeline-settings.json`은 app-api만 쓰며 secret을 담지 않는다. Whisper는 model snapshot을 위해 읽기만 한다.
- Whisper prepare endpoint는 fixed model enum만 받고 path/repo 입력을 받지 않는다. 기존 `/transcribe` body는 `{meetingId,dispatchId}` 그대로다.
- Correction checkpoint는 meeting 내부 hidden JSON 한 개다. canonical pair가 아니며 app summarize 경로만 쓴다.
- Checkpoint key가 하나라도 바뀌면 재사용하지 않는다. 사용자가 provider/model/glossary/mode를 바꾼 retry는 새 교정을 한다.
- Canonical `transcript.md`/`summary.json`은 계속 `summarizePublisher`만 transcript-first/summary-last로 발행한다.
- 실제 benchmark는 사용자가 exact meeting ID로 명시적으로 실행한 뒤 `.ai-note-runtime/benchmarks/`에만 출력한다. 원본 meeting status/artifact와 library는 읽기 전용이다.
- 새 npm/Python dependency와 lockfile 변경은 없다.

## Phase

| Phase | 이름 | 결과 |
| --- | --- | --- |
| 1 | quality-first-whisper-models | model settings, explicit prepare, claim model snapshot, bounded Whisper execution |
| 2 | durable-correction-checkpoint | 교정 checkpoint와 실패 후 manual-only retry |
| 3 | isolated-structured-llm-invocation | CLI 격리·schema output·40,000자 오경고 제거 |
| 4 | optional-fast-correction-and-benchmark | 선택형 chunk correction, chunk resume, 격리 실제 회의 benchmark |
| 5 | runtime-diagnostics-and-canonical-docs | `app:status` 회귀 수정, 문서 정렬, ADR 0024 |
| 6 | synthetic-pipeline-browser-verification | pinned Chromium 세 viewport 최종 검증 |
| 7 | full-suite-contract-repair | 새 data route inventory와 structured-summary/checkpoint 광역 test 계약 보정 |
| 8 | lint-final-gate-repair | unused callback/local만 제거해 전체 lint gate 보정 |

## 실행 방법

이 디렉터리의 `plan.json`이 경로·명령·중단 조건의 정본이다. 전용 task worktree에서 `/execute`로 전체 계획을 실행한다.

```text
/execute docs/plans/meeting-pipeline-speed-and-reliability
```

계획 실행은 실제 meeting/model/network benchmark를 자동으로 돌리지 않는다. 구현과 전체 gate가 끝난 뒤 사용자가 선택한 exact meeting ID로 새 benchmark command를 명시적으로 실행한다.

## 문서 업데이트 대상

- 제품·설치: `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`
- 에이전트·모듈 계약: `AGENTS.md`, `src/CLAUDE.md`, `whisper/CLAUDE.md`, `scripts/CLAUDE.md`
- 정본: `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/UI_GUIDE.md`
- 결정 기록: `docs/decisions/README.md`, 새 `0024-quality-first-meeting-pipeline.md`

과거 ADR의 사실을 지우지 않는다. ADR 0024가 600초 timeout 서술과 고정 `large-v3`/단일 full correction 결정 중 이번에 바뀌는 부분만 명시적으로 대체한다.

## 남은 결정

구현 전 차단 결정은 없다. 실제 benchmark 전에는 `large-v3`와 full correction을 품질 우선 default로 유지한다. Turbo 또는 fast가 품질·속도 gate를 통과했을 때 “권장” 표시나 default를 바꿀지는 benchmark 결과와 사람 검수를 본 뒤 사용자에게 다시 묻는다.
