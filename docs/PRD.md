# PRD: 회의 녹음 → 회의록 요약 (AI NOTE)

## 목표

노트북 마이크로 회의를 녹음하면 → 로컬 whisper가 배치 전사하고 → 로컬 CLI(claude/codex)나 Ollama가 맥락 기반으로 오타를 교정하고 읽기 좋은 회의록으로 요약한다. 완성된 요약은 열람·내보내기(export)할 수 있고, 파생 검색 데이터로 여러 회의의 결정·할 일·출처를 AI 없이 찾거나 근거가 연결된 질문을 할 수 있다. **혼자 쓰는 로컬 도구**로 시작하되, 품질이 좋으면 실사용한다.

## 사용자

단일 사용자(dylan) 1인. 멀티유저·워크스페이스·협업은 대상 아님.

## 핵심 기능 (MVP-0)

1. **녹음** — 브라우저 마이크로 오디오만 캡처(실시간 자막 없음). 레벨미터·타이머로 "녹음되고 있음" 확인, 페이지 이탈 경고.
2. **배치 전사** — 녹음 종료 시 로컬 whisper(mlx large-v3)가 전체 오디오를 한 번에 전사. 세그먼트 타임스탬프 포함.
3. **교정 + 요약** — 전사가 끝나면 앱의 백그라운드 워커가 로컬 CLI(claude/codex)나 Ollama로 오타·문단 교정(`transcript.md`) + 구조화 요약(`summary.json`)을 만든다. 외부 API 키 불필요(구독/로컬 모델, 비용 $0).
4. **2탭 상세** — 웹에서 회의별 상세를 **전체 스크립트 / 회의록 요약** 두 탭으로 열람. 참석자·프로젝트를 검토 단계에서 입력.
5. **내보내기(export)** — 완성된 회의록 요약을 열람하고 파일로 내보낸다. 이후 활용(공유·아카이브 등)은 사용자가 결정한다.
6. **회의록 관리** — 회의 목록에서 요약 완료된 회의의 **제목 수정**(AI 자동 제목을 사람이 교정, `titleOverride`로 보존)과 불필요한 회의록 **영구 삭제**(인라인 확인).
7. **단어 관리(단어장) + 좌측 네비게이션** — 도메인 용어와 '잘못 인식→올바른 표기' 교정쌍을 웹 **단어 관리** 탭에서 관리(LLM 교정 단계에 반영, whisper STT 아님). 좌측 사이드바로 회의·단어·설정을 오간다.
8. **로컬 회의 라이브러리** — desktop rail/mobile drawer에서 workspace를 전환하고 모든 회의·미분류·최대 3단계 folder의 direct meeting을 bounded page로 본다. Workspace/folder 생성·이름 수정과 folder semantic color 편집을 제공한다. Meeting은 same/cross-workspace의 folder·미분류로 이동할 수 있고 folder subtree는 같은 workspace 안에서만 reparent한다. Folder 삭제는 direct meeting rehome+child 승격, workspace 삭제는 destination unfiled rehome이며 둘 다 preview 뒤 조직 metadata만 제거하고 meeting artifact를 보존한다. 중앙 `library.json` placement/tree metadata만 바꾸며 Meeting artifact는 안정적인 `data/meetings/{id}/`에 둔다. Workspace는 계정·팀·권한·암호화 또는 물리 저장 경계가 아니다. Registry degraded 시 last-good/global fallback을 읽기 전용으로 제공하고, corrupt에만 fingerprint 확인·원본 archive 보존형 명시적 재구축을 제공한다. Unsupported/I/O/conflict는 덮지 않는다.
9. **단건 수동 재요약** — 요약 완료된 회의 상세의 **"다시 요약"** 버튼으로 그 회의 하나만 재생성(단어장 변경을 기존 회의에 반영). **자동·일괄 재요약은 비목표** — 단어장 저장은 재요약을 트리거하지 않고, 배경 워커는 요약된 회의를 다시 요약하지 않는다.
10. **회의 지식 검색·질문 확장** — 파생 지식 카드와 corpus map으로 전체 회의를 결정적으로 검색하고, configured CLI/Ollama를 재사용하는 도구 호출형 챗봇이 서버가 실제 read·live 재검증한 근거에만 claim-level inline citation과 reference list를 제공한다. 번호·현재 제목·링크는 서버가 만들며, 사용자 프로필은 선택적 개인화라 미설정이어도 일반 검색·질문은 동작한다. 질문 응답은 non-streaming이고 완결 4 turn의 현재 탭 메모리만 사용한다.

## MVP 제외 사항 (비목표)

- 캘린더 연동, 데스크탑 앱, 시스템 오디오(Zoom/Meet) 캡처
- 공유/협업·workspace 구성원/권한, cloud sync, 템플릿 관리 UI, 플랜/결제, MCP
- 멀티유저·인증(단일 사용자 로컬 가정)
- 화자 분리(diarization) — whisper 배치에 화자 정보 없음
- **실시간 자막** — 품질 우선을 위해 배치 전사를 택함(사용자 확정 결정)
- vector DB/embedding 기반 semantic search · 모델의 임의 파일 접근/출처 번호 생성 · streaming/background chat job · 서버 영구 대화 기록

### v2로 명시적 연기
chunk-append 크래시 복구 + 디코드 게이트 · 전체 상태 FSM + stale-job 워치독 · map-reduce 요약/refine 청킹 · auto-queue-on-green · 세그먼트 클릭 재생 · 무음 워치독/장치 선택/일시정지 · capture_id 재스캔 idempotency · Playwright e2e.

## 아키텍처/제품 상 유의점

- **자동 요약 워커**: 전사가 끝나면 앱이 백그라운드 워커로 사용자의 로컬 CLI(claude/codex)나 Ollama를 호출해 교정·요약한다. 외부 API 키를 저장하지 않는다(구독/로컬 모델). 요약은 완성 후 사람이 검토한다.
- **자동 전사 on stop**: 녹음 종료 시 앱이 whisper 전사까지는 자동 위임 → 터미널 전에 원본 스크립트가 앱에 뜬다.
- **검색·질문 경계**: 단순 검색은 LLM을 호출하지 않고 `knowledge-card.json`/`corpus-map.json`과 query-time live metadata만 사용한다. 질문은 새 API-key surface 없이 저장된 CLI/Ollama 설정을 재사용하며, 서버는 bounded tool output과 citation provenance를 검증한다. 프로필·검색 파생물은 `data/`에만 저장하고 대화 history는 서버 파일에 저장하지 않는다. Claude/Codex CLI를 선택하면 전달된 bounded prompt/evidence의 provider 처리는 사용자가 로그인한 CLI의 정책을 따르며, Ollama는 explicit loopback만 허용한다.
- **중단 안전 저장**: 녹음 종료 저장은 body 전에 intent를 고정하고 audio+initial status를 한 directory로 publish한다. 응답 유실 뒤 같은 meeting ID로 재시도하면 원본 오디오를 덮지 않고 playback·위치·전사 상태를 복구한다.
- **범위별 recorder 위치·복구 UX**: Ready의 Workspace All/미분류는 해당 workspace 미분류, folder는 exact folder를 녹음 시작 순간 ID로 고정한다. Last-good은 마지막 위치를 요청하되 실제 배치가 unavailable/fallback일 수 있음을 먼저 알리고, fresh global fallback은 조직 위치 없이 저장한다. 응답 유실·5xx에서는 같은 ID를 body 없이 probe한 뒤 미게시가 확인된 경우에만 보존 Blob을 다시 전송한다. 저장 결과는 원본 내구성·실제 위치·재생 준비·전사를 각각 표시한다.
- **원본 불가침**: `audio.webm`·`raw.md`·`segments.json`은 불변. `transcript.md`·`summary.json`은 언제든 재생성 가능.

## 디자인 방향

- 웜 베이지/브라운 미니멀, "도구처럼"(마케팅 페이지 아님). Pretendard.
- 상세는 2탭. 상단 우측 다크 "실시간 기록 시작" 버튼. 자세한 규칙은 `UI_GUIDE.md`.
