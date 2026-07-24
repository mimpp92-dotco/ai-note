# PRD: 회의 녹음 → 회의록 요약 (AI NOTE)

## 목표

노트북 마이크로 회의를 녹음하면 → 로컬 whisper가 배치 전사하고 → 로컬 CLI(claude/codex)나 Ollama가 맥락 기반으로 오타를 교정하고 읽기 좋은 회의록으로 요약한다. 완성된 요약은 열람·내보내기(export)할 수 있고, 파생 검색 데이터로 여러 회의의 결정·할 일·출처를 AI 없이 찾을 수 있다(근거가 연결된 **질문(챗봇)**은 현재 dormant — 아래 참조). **혼자 쓰는 로컬 도구**로 시작하되, 품질이 좋으면 실사용한다.

## 사용자

단일 사용자(dylan) 1인. 멀티유저·워크스페이스·협업은 대상 아님.

## 핵심 기능 (MVP-0)

1. **녹음** — 브라우저 마이크로 오디오만 캡처(실시간 자막 없음). 레벨미터·타이머로 "녹음되고 있음" 확인, 페이지 이탈 경고.
2. **배치 전사** — 녹음 종료 시 로컬 whisper(mlx large-v3)가 전체 오디오를 한 번에 전사. 세그먼트 타임스탬프 포함.
3. **최초 교정 + 요약** — 전사가 끝나면 앱의 백그라운드 워커가 로컬 CLI(claude/codex)나 Ollama로 최초 자동 전사 원문을 오타·문단 교정한 전체 스크립트와, 그 스크립트에 근거한 구조화 요약을 차례로 만든다. 이 결합 파이프라인은 최초 생성에만 사용하며 외부 API 키는 필요 없다(구독/로컬 모델, 비용 $0).
4. **2탭 상세·수동 수정** — 웹에서 회의별 상세를 **전체 스크립트 / 회의록 요약** 두 탭으로 열람하고 각각 직접 수정·저장한다. 선택된 탭의 로컬 작업은 tablist 바로 다음, 경고와 본문보다 앞에 둔다. 수정 중에는 읽기 본문을 하나의 multiline textarea로 교체하며, 요약은 생성된 heading·bullet을 포함한 전체 읽기 본문을 자유 plain text 하나로 편집한다. 제목은 목록의 전용 제목 수정, 참석자는 상세 `회의 정보` 입력에서만 바꾼다.
5. **내보내기(export)** — 완성된 회의록 요약을 열람하고 파일로 내보낸다. 이후 활용(공유·아카이브 등)은 사용자가 결정한다.
6. **회의록 관리** — 회의 목록에서 요약 완료된 회의의 **제목 수정**(AI 자동 제목을 사람이 교정, `titleOverride`로 보존)과 불필요한 회의록 **영구 삭제**(인라인 확인).
7. **단어 관리(단어장) + 좌측 네비게이션** — 도메인 용어와 '잘못 인식→올바른 표기' 교정쌍을 웹 **단어 관리** 탭에서 관리(LLM 교정 단계에 반영, whisper STT 아님). 좌측 사이드바로 회의·단어·설정을 오간다.
8. **로컬 회의 라이브러리** — desktop rail/mobile drawer에서 workspace를 전환하고 모든 회의·미분류·최대 3단계 folder의 direct meeting을 bounded page로 본다. Workspace/folder 생성·이름 수정과 folder semantic color 편집을 제공한다. Meeting은 same/cross-workspace의 folder·미분류로 이동할 수 있고 folder subtree는 같은 workspace 안에서만 reparent한다. Folder 삭제는 direct meeting rehome+child 승격, workspace 삭제는 destination unfiled rehome이며 둘 다 preview 뒤 조직 metadata만 제거하고 meeting artifact를 보존한다. 중앙 `library.json` placement/tree metadata만 바꾸며 Meeting artifact는 안정적인 `data/meetings/{id}/`에 둔다. Workspace는 계정·팀·권한·암호화 또는 물리 저장 경계가 아니다. Registry degraded 시 last-good/global fallback을 읽기 전용으로 제공하고, corrupt에만 fingerprint 확인·원본 archive 보존형 명시적 재구축을 제공한다. Unsupported/I/O/conflict는 덮지 않는다.
9. **단건 독립 재생성** — 요약 완료 회의에서 두 operation을 분리한다. **"원문에서 스크립트 다시 만들기"**는 최초 자동 전사 원문과 현재 단어장으로 전체 스크립트만 교정하고 기존 요약을 보존한다. **"현재 스크립트로 요약 다시 만들기"**는 현재 저장된 전체 스크립트로 요약만 만들고 스크립트를 보존한다. 스크립트 변경 뒤 기존 요약은 삭제하지 않고 **"요약 갱신 필요"**로 표시하며, 요약 직접 저장 또는 재생성 뒤 다시 최신 상태가 된다. **자동·일괄 재생성은 비목표**이고 단어장 저장도 기존 회의를 자동 갱신하지 않는다.
10. **회의 지식 검색·질문 확장** — 파생 지식 카드와 corpus map으로 전체 회의를 결정적으로 검색하고, configured CLI/Ollama를 재사용하는 도구 호출형 챗봇이 서버가 실제 read·live 재검증한 근거에만 claim-level inline citation과 reference list를 제공한다. **단, 챗봇(질문/회의 도우미) UI는 현재 dormant다** — build-time flag `MEETING_ASSISTANT_ENABLED`(기본 `false`)로 마운트만 차단하고 코드·`/api/chat`·공유 지식 인덱스는 보존한다(ADR 0019). AI 없는 단순 검색과 검색 파생물은 dormant와 무관하게 동작한다. 아래 서술은 챗봇을 되살릴 때(flag=`true`)의 목표 계약이다. 번호·현재 제목·링크는 서버가 만들며, 사용자 프로필은 선택적 개인화라 미설정이어도 일반 검색·질문은 동작한다. 질문 응답은 non-streaming이고 완결 4 turn의 현재 탭 메모리만 사용한다. 진입은 별도 `/search` 페이지가 아니라 앱 셸의 두 표면이다: 좌측 사이드바 최상단 돋보기 `검색` 트리거가 여는 검색 오버레이와, 우측 접이식 `회의 도우미` 챗봇 패널(모바일은 drawer). 챗봇은 요약 기반 `search_meetings` 외에 전사 본문을 훑는 discovery 전용 `search_transcripts` 도구를 가져 고유명사·별칭이 요약에서 사라진 회의도 후보로 찾되, discovery 결과 자체는 근거가 아니며 그 회의를 요약·전사 도구로 다시 읽어야 citation이 된다. AI 없는 단순 검색은 여전히 전사 전문을 읽지 않는다.
11. **설치·첫 실행** — Clone 뒤 `node scripts/bootstrap.mjs --launch` 하나가 전제 진단, `HUSKY=0 npm ci`, build, bounded dynamic loopback port의 owned background app/Whisper, health, 실제 URL browser open을 조율한다. 첫 화면은 요약 모델 미설정/불가를 recorder 앞에서 비차단으로 안내하고 **AI 요약 설정 / 요약 없이 회의 녹음**을 제공한다. Provider별 native model selector와 저장 직후 persisted health를 제공하며 요약 모델이나 optional 내 정보가 없어도 녹음·로컬 전사·일반 검색은 가능하다.
12. **전사 실패 복구·완료 기본 보기** — `retry_transcription`은 목록·상세·저장 결과에 지속 표시하고 exact meeting ID로 기존 durable transcribe API를 다시 호출한다. 완료 회의는 explicit query가 없고 usable summary가 있으면 **회의록 요약**을 기본 tab으로 연다.

## MVP 제외 사항 (비목표)

- 캘린더 연동, 데스크탑 앱, 시스템 오디오(Zoom/Meet) 캡처
- 공유/협업·workspace 구성원/권한, cloud sync, 템플릿 관리 UI, 플랜/결제, MCP
- 멀티유저·인증(단일 사용자 로컬 가정)
- 화자 분리(diarization) — whisper 배치에 화자 정보 없음
- **실시간 자막** — 품질 우선을 위해 배치 전사를 택함(사용자 확정 결정)
- vector DB/embedding 기반 semantic search · 모델의 임의 파일 접근/출처 번호 생성 · streaming/background chat job · 서버 영구 대화 기록
- 최초 자동 전사 원문 직접 수정, 수동 수정 이력/merge UI, autosave
- 최초 생성 뒤 스크립트 교정과 요약을 한 번에 다시 실행하는 결합 재생성, 스크립트 변경 직후의 무확인 자동 요약 갱신

### v2로 명시적 연기
chunk-append 크래시 복구 + 디코드 게이트 · 전체 상태 FSM + stale-job 워치독 · map-reduce 요약/refine 청킹 · auto-queue-on-green · 세그먼트 클릭 재생 · 무음 워치독/장치 선택/일시정지 · capture_id 재스캔 idempotency.

## 아키텍처/제품 상 유의점

- **자동 요약 워커**: 전사가 끝난 최초 한 번만 앱이 백그라운드 워커로 사용자의 로컬 CLI(claude/codex)나 Ollama를 호출해 교정본과 그 교정본의 요약을 만든다. 이후 스크립트·요약 생성은 상세에서 사용자가 종류별로 명시적으로 시작하며 서로를 자동 재생성하지 않는다. 외부 API 키를 저장하지 않는다(구독/로컬 모델).
- **자동 전사 on stop**: 녹음 종료 시 앱이 whisper 전사까지는 자동 위임 → 터미널 전에 원본 스크립트가 앱에 뜬다.
- **검색·질문 경계**(질문/챗봇 표면은 현재 dormant, ADR 0019 — 아래는 보존되는 계약): 단순 검색은 LLM을 호출하지 않고 `knowledge-card.json`/`corpus-map.json`과 query-time live metadata만 사용한다(전사 전문 미열람). 수동 자유 본문은 `회의록 본문`으로 검색하지만 그 text에서 action item·담당자·기한을 추론하지 않는다. 질문은 새 API-key surface 없이 저장된 CLI/Ollama 설정을 재사용하며, 서버는 bounded tool output과 citation provenance를 검증한다. 챗봇 도구 계층에만 discovery 전용 `search_transcripts`가 있어 bounded snippet으로 전사 본문을 훑지만 citation credit은 주지 않는다. 프로필·검색 파생물은 `data/`에만 저장하고 대화 history는 서버 파일에 저장하지 않는다. Claude/Codex CLI를 선택하면 전달된 bounded prompt/evidence의 provider 처리는 사용자가 로그인한 CLI의 정책을 따르며, Ollama는 explicit loopback만 허용한다.
- **중단 안전 저장**: 녹음 종료 저장은 body 전에 intent를 고정하고 audio+initial status를 한 directory로 publish한다. 응답 유실 뒤 같은 meeting ID로 재시도하면 원본 오디오를 덮지 않고 playback·위치·전사 상태를 복구한다.
- **범위별 recorder 위치·복구 UX**: Ready의 Workspace All/미분류는 해당 workspace 미분류, folder는 exact folder를 녹음 시작 순간 ID로 고정한다. Last-good은 마지막 위치를 요청하되 실제 배치가 unavailable/fallback일 수 있음을 먼저 알리고, fresh global fallback은 조직 위치 없이 저장한다. 응답 유실·5xx에서는 같은 ID를 body 없이 probe한 뒤 미게시가 확인된 경우에만 보존 Blob을 다시 전송한다. 저장 결과는 원본 내구성·실제 위치·재생 준비·전사를 각각 표시한다.
- **원본 불가침**: `audio.webm`·`raw.md`·`segments.json`은 불변. `transcript.md`·`summary.json`은 언제든 재생성 가능.
- **파생 콘텐츠 최신성**: 전체 스크립트 직접 저장·재생성은 기존 요약을 보존하되 최신이 아님을 표시한다. 요약 직접 저장·재생성은 반드시 현재 전체 스크립트를 기준으로 하며, 저장 충돌이나 결과 불명확 상태에서는 사용자 입력을 보존하고 확인 없이 덮어쓰거나 재전송하지 않는다.
- **설치 target·runtime 경계**: URL만 받은 agent는 다른 repo 안이면 그 root sibling, 아니면 cwd child의 새 `ai-note`를 선택하고 충돌 시 deterministic suffix를 쓴다. 명시 non-empty/다른 origin target은 중단한다. Clone/install은 target 밖 ancestor/global/project/process를 수정하지 않는다. Bootstrap은 기존 port process를 재사용·종료하지 않고 repository-local ownership state가 검증된 supervisor만 status/stop한다. 성공 handoff는 absolute path, revision, actual URL을 포함한다.
- **첫 실행 정직성**: `회의 녹음 시작`이 recording CTA다. 선택 Whisper model의 첫 download는 오래 걸릴 수 있고 download 전에는 가짜 progress를 표시하지 않는다. CLI health 성공은 binary 감지일 뿐 인증/실제 생성 성공을 보장하지 않으며 Ollama 성공은 선택한 설치 model의 loopback 연결을 뜻한다.

## 디자인 방향

- 웜 베이지/브라운 미니멀, "도구처럼"(마케팅 페이지 아님). Pretendard.
- 상세는 2탭. 녹음 CTA는 다크 **"회의 녹음 시작"** 버튼. 자세한 규칙은 `UI_GUIDE.md`.
