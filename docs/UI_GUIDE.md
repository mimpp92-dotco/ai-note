# UI 디자인 가이드

## 디자인 원칙

1. **도구처럼 보여야 한다.** 마케팅 랜딩이 아니라 매일 쓰는 로컬 대시보드.
2. **웜 미니멀.** 베이지/브라운 계열, 저채도, 여백 넉넉.
3. **상태가 항상 보인다.** 녹음/전사/요약 각 단계 상태를 명시적으로 표시(색만이 아니라 아이콘+텍스트).

## AI 슬롭 안티패턴 — 하지 마라

| 금지 | 이유 |
|------|------|
| `backdrop-filter: blur()` (glassmorphism) | AI 템플릿의 가장 흔한 징후 |
| gradient-text (배경 그라데이션 텍스트) | AI SaaS 랜딩 1번 특징 |
| "Powered by AI" 배지 | 장식일 뿐 가치 없음 |
| box-shadow 글로우 애니메이션 | 네온 글로우 = AI 슬롭 |
| 보라/인디고 브랜드 색상 | "AI = 보라색" 클리셰 |
| 모든 카드 동일한 rounded-2xl | 균일 둥근 모서리 = 템플릿 느낌 |
| 배경 gradient orb (blur-3xl 원형) | 모든 AI 랜딩의 장식 |

## 색상 (웜 베이지/브라운)

### 배경/면
| 용도 | 값 |
|------|------|
| 페이지 | `#FAF8F4` |
| 카드/패널 | `#FFFFFF` |
| 옅은 면(라인소프트) | `#F0EBE3` |
| 크롬(툴바) | `#F4EFE8` |

### 텍스트
| 용도 | 값 |
|------|------|
| 주 텍스트(ink) | `#2A2420` |
| 본문/보조(ink-soft) | `#6B6158` |
| 비활성(ink-faint) | `#9A8F84` — **소형 텍스트 금지(대비 부족), `#6B6158` 이상 사용** |

### 액센트/시맨틱
| 용도 | 값 |
|------|------|
| 액센트(브라운) | `#5B4A42` |
| 라인 | `#E8E1D7` |
| 성공/완료 | `#3F7A55` (bg `#E4F0E7`) |
| 경고/주의 | `#B4791F` (bg `#FBF0DA`) |
| 에러 | `#C0392B` (파괴적 버튼 bg — 텍스트는 `#FAF8F4`, hover 시 opacity 90%) |

## 타이포그래피
| 용도 | 스타일 |
|------|--------|
| sans | Pretendard, -apple-system, "Apple SD Gothic Neo", system-ui |
| mono | ui-monospace, "SF Mono", Menlo (타이머·경로·코드블록·단축키) |
| 페이지 제목 | ~24px, weight 720, letter-spacing -.018em |
| 카드 제목 | ~16–19px, weight 700 |
| 본문 | ~14–15px, line-height 1.6, `#6B6158` |

## 레이아웃
- **앱 셸**: desktop `lg` 이상은 약 272px library rail(`border-r border-line`, `bg-chrome`) + 콘텐츠(`flex-1 min-w-0`)를 기본으로 하며, 회의 도우미가 활성일 때 우측 접이식 회의 도우미 `<aside>`(`border-l border-line`, `bg-chrome`, 약 380px)가 세 번째 flex child로 붙어 3열 flex 셸이 된다. **회의 도우미(챗봇)는 현재 dormant다** — `MEETING_ASSISTANT_ENABLED`(`src/lib/features.ts`, 기본 `false`)가 `true`일 때만 `layout.tsx`가 이 `<aside>`(및 mobile launcher)를 마운트하며, dormant 상태에서는 셸이 2열로만 렌더된다(ADR 0019, §검색·질문 참조). 활성 시 aside는 접으면 우측 세로 `회의 도우미` 재열기 토글만 남는다. Mobile/tablet은 64px top bar와 `h-dvh` modal drawer를 사용하고, 활성 시 회의 도우미는 좌하단 launcher가 여는 `AppDrawer`로 제공한다. Modal dialog/drawer는 native `<dialog>.showModal()` browser top layer를 사용해 background inert와 focus containment를 얻고, app-level ref-count scroll lock으로 body 스크롤을 막는다. Native dialog가 아닌 popup만 별도 layer를 쓴다.
- **Library rail 구조**: identity → workspace switcher/create/rename → 돋보기 `검색` 트리거 → `모든 회의`/`미분류` → 독립 scroll folder section → 위치 저장 대기/단어 관리/설정 → shared 전사·요약 health. 진입 순서는 검색 → 모든 회의 → 폴더다. `검색` 트리거는 shared `SearchOverlay`(native top-layer `AppDialog`)를 열며 별도 `/search` 페이지는 없다. 프로필/팀/권한/템플릿/사용량 위젯은 없다.
- **Folder tree**: nested `ul/li`를 쓰고 disclosure, scope link, edit/create-child trigger를 분리한다. 구현하지 않은 full ARIA tree role은 선언하지 않는다. Active ancestor는 자동 expand하며 depth 3에서는 child create를 노출하지 않고 최대 깊이 이유를 제공한다. 색상은 dot만 쓰지 않고 브라운/샌드/앰버/올리브/세이지 label과 selected shape/text를 함께 쓴다.
- **Navigation active state**: 활성 scope/link는 `aria-current="page"`, `bg-soft`, `text-ink`, 더 선명한 weight를 함께 사용한다. Canonicalization은 old list 대신 skeleton과 한 번의 `aria-live` reason을 보인다.
- 각 페이지는 자체 `<main id="main">`을 **좌측 정렬**로 소유(`mx-auto` 없이 `max-w-5xl`/`max-w-2xl` + mobile `px-4`, `sm` 이상 `px-6`, 기본 `py-12`). Root의 `overflow-x-hidden`으로 오류를 가리지 않고 각 content owner가 `min-w-0`, wrap/truncate와 element-level boundary를 책임진다.
- 전체 너비: `max-w-5xl` 좌측 정렬 기본.
- 카드: `#FFFFFF` + `1px solid #E8E1D7` + radius 14–18px + 은은한 shadow(`0 1px 2px rgba(42,36,32,.04), 0 8px 28px -12px rgba(42,36,32,.18)`). 내부 padding은 mobile 16px, `sm` 이상 24px이 기본이며 long title/breadcrumb/banner copy는 action과 폭을 경쟁하지 않고 먼저 reflow한다.
- 간격: 요소 gap 3~4, 섹션 간 space-y-8.

### Control shape·target grammar

- 독립 text/icon control은 최소 44×44px target과 hover와 독립된 `focus-visible` ring을 가진다. Chip 내부 remove처럼 조밀한 종속 control만 32×32px 예외다.
- 같은 local action group은 height·radius·간격을 맞춘다. Workspace create/rename과 meeting inline action은 rectangular group을 유지하고, Recorder CTA·pagination의 기존 pill과 status/tag/chip pill은 보존한다.
- Workspace select는 native `<select>` semantics를 유지하면서 `appearance-none`과 충분한 우측 padding을 사용한다. 우측 16px inset의 `pointer-events:none`, `aria-hidden` SVG chevron이 text 영역과 겹치지 않아야 하며 desktop rail/mobile drawer가 같은 markup을 쓴다.

## 아이콘/애니메이션
- SVG 인라인, strokeWidth 1.5. Library의 kebab/chevron/plus/menu/close는 shared `currentColor` icon을 쓰고 accessible name은 button의 `aria-label`이 소유한다. 아이콘을 둥근 배경 박스로 감싸지 않는다.
- 허용 애니메이션: fade-in(~0.3s), 녹음 중 red dot pulse. 그 외 금지. `prefers-reduced-motion` 존중(pulse 정지).

## 화면 스펙 (상태별)

### 검색·질문

> **현재 dormant 안내(ADR [0019](decisions/0019-meeting-assistant-dormant.md)):** 이 절의 **질문(회의 도우미 챗봇)** 표면은 build-time flag `MEETING_ASSISTANT_ENABLED`(기본 `false`)로 마운트가 차단돼 사용자에게 노출되지 않는다. 아래 질문·답변·챗봇 관련 스펙은 챗봇을 되살릴 때(flag=`true`)의 목표 디자인이며 코드·`/api/chat`은 보존된다. **검색(SearchOverlay)** 표면과 그 스펙은 dormant와 무관하게 그대로 유효하다.

- **두 표면 구조(정본)**: 검색과 질문은 하나의 `/search` 탭 페이지가 아니라 앱 셸의 두 진입점으로 나뉜다. **검색**은 좌측 rail/모바일 drawer 최상단의 돋보기 `검색` 트리거가 여는 shared `SearchOverlay`(native top-layer `AppDialog`)이고, **질문(챗봇)**은 우측 접이식 `회의 도우미` 패널(desktop `<aside>` · mobile `AppDrawer`)이다. 두 표면은 같은 `useMeetingSearch`/`SearchPanel`(검색)과 hoisted `useChatController`/`ChatClient`(질문) 로직을 재사용한다. 챗봇 답변의 `검색 결과로 보기`/`검색에서 찾아보기` 액션은 페이지 이동 없이 같은 `SearchOverlay`를 열며, `searchReplay`가 있으면 열림과 동시에 서버가 만든 검색을 한 번 재생한다. 별도 탭 전환·`질문`/`검색` Tabs·기본 진입 탭 개념은 없다.
- 비스트리밍 응답 중에는 확인할 수 없는 가짜 세부 진행 단계를 표시하지 않고 단일한 처리 중 상태만 알린다.
- **검색 composition**: compact page heading 아래 검색 input과 명시적 dark `검색` primary action 하나를 둔다. Date/workspace/folder/status/action-item 조건은 기본 닫힌 native `필터` disclosure에 넣고, disclosure 밖에서도 active filter count와 `필터 초기화`를 확인할 수 있게 한다. 320px에서는 input/action과 filter field를 한 열로 쌓으며 Korean IME composition 중 Enter는 submit하지 않는다.
- **검색 결과 hierarchy**: 결과는 card grid나 nested card가 아니라 위아래 divider를 공유하는 단일 column list다. 각 row는 live title → 날짜·live 위치·live 상태 한 metadata group → 최대 3개의 matched-field label/plain excerpt → 최소 44px `회의 열기` 순서다. `hasMore`는 “상위 N개 결과”와 검색어/필터를 좁히는 설명만 제공하고 다음/더 보기 control을 만들지 않는다.
- Initial, 검색 중, 결과, 결과 없음, partial, unavailable, request error를 서로 다른 copy와 다음 행동으로 구분한다. 결과 없음은 검색어 축소와 filter reset을 안내하고, 요약 대기 회의는 제목·날짜·위치·참석자만 검색될 수 있음을 설명한다. Loading·request failure·재색인 중에도 이전 결과 surface와 현재 draft를 유지하고 결과 container에는 최소 높이를 둔다.
- 프로필 미설정은 일반 검색·질문을 막는 오류가 아니다. ‘내 할 일’·상대 날짜처럼 자기 지칭 해석에 개인화 정보가 필요한 경우에만 비차단 설정 안내로 표시한다.
- 근거가 있는 claim 바로 뒤에 inline `[n]` marker를 두고 답변 아래 reference list를 제공한다. 같은 meeting은 답변 안에서 stable number를 유지하며, 복사 결과에도 reference list를 포함한다. 번호·제목·link는 모델 출력이 아니라 서버가 검증한 meeting으로 생성한다.
- **검색 데이터 상태**: ready는 별도 성공 배지를 만들지 않는다. Partial은 현재 결과·검색어·필터를 그대로 유지한 채 “일부 회의의 검색 데이터가 아직 최신 상태가 아닙니다” warning과 `검색 데이터 업데이트` CTA를 결과 위에 둔다. Unavailable은 입력한 검색어·필터를 보존하고 결과 영역에 복구 설명과 같은 CTA를 둔다. 현재 UI는 내부 `missing|stale|corrupt|io_error`를 reason별 진단 문구로 노출하지 않고 partial/unavailable의 안전한 aggregate copy로 낮춘다. `index`, `stale`, `corrupt`, raw path/error는 화면에 그대로 표시하지 않는다.
- **재색인 CTA**: CTA 실행 중에도 current query/filter와 기존 결과·답변을 지우거나 입력을 disable하지 않는다. 성공하면 같은 query/filter를 자동 재실행하고 결과 heading에 polite 상태를 알린다. 실패하면 기존 결과·답변·draft와 focus를 유지한 inline error를 보여 주고 사용자가 다시 시도하거나 회의를 열 수 있게 한다. 재색인은 페이지 이동, polling job, progress stream처럼 표현하지 않는 한 번의 동기 요청이다.

#### 검색·질문 고정 디자인 브리프

| 항목 | 규칙 |
|---|---|
| 사용자 상황 | 혼자 여러 회의 사이의 결정·할 일·출처를 반복해서 찾는 사용자이며 긴 제목·답변과 불완전한 검색 데이터가 정상 상태다. |
| 시각 register | Product / restrained / earned familiarity. Assistant persona, avatar, marketing hero, chat bubble, nested card를 만들지 않는다. |
| 화면 순서 | 검색 오버레이는 `회의 검색` dialog heading → 검색 input + dark `검색` primary action 하나 → 필터 disclosure → 상태와 결과. 질문 패널은 `회의 도우미` heading → 대화(질문 heading + assistant `article`) → 질문 composer 순서다. 각 표면에는 dark primary action을 하나만 둔다(검색=`검색`, 질문=`질문하기`). |
| 읽기 폭·간격 | 답변은 16px, line-height 1.6~1.7, 약 65~72ch로 제한한다. related gap은 8/12/16px, section gap은 24/32px의 기존 scale을 사용한다. |
| 색·면·motion | 기존 warm palette와 system sans만 사용한다. 성공을 큰 배지로 만들지 않고 warning/error에만 필요한 semantic surface를 쓴다. 장식 motion·gradient·glass·glow를 추가하지 않는다. |

- 질문 composer는 visible label, 1~5줄 auto-grow, `Enter` 제출, `Shift+Enter` 줄바꿈, Korean IME 조합 Enter 무시를 제공한다. 실행 중에는 입력·이전 답변을 유지하고 `답변을 준비하고 있습니다`처럼 실제로 아는 상태만 표시한다.
- 대화는 사용자 질문 heading과 assistant `article`을 divider/spacing으로만 구분한다. 현재 브라우저 탭의 React 메모리에 완결 4 turn까지만 유지하며 `대화 지우기`를 제공하고, 새로고침 뒤에는 복원하지 않는다.
- 답변은 server-built segment만 plain React text로 렌더한다. 문단은 `<p>`, 연속 bullet은 `<ul>/<li>`이며 HTML/Markdown을 주입하지 않는다.
- 읽기 순서는 claim과 inline `[n]` → 해당할 때 출처·검색 데이터·개인화 복구 안내 → divider형 `참고 회의` ordered list → deep 실패 안내 → 답변 action → 기본 닫힌 `확인한 범위`다. 같은 답변의 같은 회의는 같은 번호를 재사용하고, 각 assistant turn은 독립 fragment ID를 사용한다.
- 답변 action은 최대 `더 깊게 찾기`, `검색 결과로 보기`, `답변 복사` 세 개다. `더 깊게 찾기`만 deep 재실행을 만들고, 실패하면 기존 답변을 유지한다. 복사 결과에는 inline 번호와 현재 제목·날짜의 참고 회의 목록을 포함하되 local href나 meeting ID는 넣지 않는다.
- 답변 완료는 focus를 옮기지 않는다. Inline marker를 활성화했을 때만 연결된 reference row를 scroll하고 programmatic focus한다. 독립 control은 44px target과 visible focus를 유지한다.
- 외부 디자인 레퍼런스는 검토 절차의 참고일 뿐 runtime/install dependency가 아니다. AI NOTE의 기존 palette, type, `AppDialog`/`AppDrawer`, control grammar가 항상 우선한다.

#### 검색·질문 상태 matrix

| Surface | 상태 | 필수 UX |
|---|---|---|
| 질문 composer | pristine / draft / IME / submitting / error | visible label, 한 primary action, 중복 제출 방지, draft 보존, 정직한 한 줄 상태 |
| 답변 | 출처 충분 / 일부 / 없음 / deep 실행·실패 / copied | 기존 답변 보존, inline reference, 참고 회의, 상태별 다음 행동, 복사 feedback 한 번 |
| 검색 | initial / loading / results / empty / partial / unavailable / request·update error | query·filter·기존 결과 보존, 서로 다른 copy와 복구, pagination을 암시하지 않음 |
| 내 정보 | loading / load error / pristine / dirty / saving / saved / durability pending / error | 요약 모델 section과 독립, load error overwrite 차단, draft 보존 |

#### 사용자 용어

| 내부 표현 | 화면 표현 |
|---|---|
| index / knowledge-card / corpus-map | 검색 데이터 |
| stale / partial index | 일부 회의가 아직 최신 상태가 아님 |
| evidence / evidence status | 출처 / 출처 확인 상태 |
| budget exhausted / truncation | 확인할 범위가 커서 일부만 확인함 |
| LLM / provider error | 요약 모델 / 답변을 만들지 못함 |
| claim / tool / raw error code | 화면에 노출하지 않음 |

#### Phase 7 검증 기준선

- Synthetic fixture만 사용한 perceptual pass와 technical pass를 `1440×900`, `768×1024`, `390×844`, `320×720`, `1280×800 @ 200%`에서 완료했다. 실제 사용자 데이터는 사용하지 않았다.
- Keyboard primary flow, AA contrast, 긴 CJK/English overflow를 확인했고 horizontal overflow·console error·미해결 P0/P1은 0이었다. 기존 디자인 시스템만 사용했으며 새 runtime/design dependency는 추가하지 않았다.

오류·복구 문장은 `무엇이 실패했는지 → 입력과 기존 결과가 보존됐는지 → 다음 행동` 순서로 쓴다. Raw path, meeting ID, provider output, 내부 상태 코드는 표시하지 않는다.

### 녹음 화면
- 상단 우측 **다크 "회의 녹음 시작"** 버튼. 실시간 자막/기록을 약속하지 않는다. 녹음 중: 펄스 red dot + "기록 중" + `mm:ss` 타이머(mono) + **레벨 미터**(입력 소리 확인). 마이크 무음 시 레벨 0 = 사용자가 문제 인지. 페이지 이탈 시 `beforeunload` 경고.
- 첫 전사는 선택한 Whisper model을 먼저 내려받느라 오래 걸릴 수 있다고 recorder helper에서 알린다. Model download가 끝나기 전에는 전사 percentage를 알 수 있는 것처럼 가짜 progress를 표시하지 않는다. 내부 `best-effort` 같은 운영 용어는 사용자 copy에 쓰지 않는다.
- 시각 timer와 `role="meter"`의 빠른 값 변화는 live region 밖에 둔다. Full/compact recorder 모두 작은 전용 `role="status" aria-live="polite"`가 권한 확인·기록 시작·정리·저장·실패 같은 phase 전환만 알린다.
- Non-idle 녹음 session은 layout 우하단 compact control(`min-height:44px`)로 모든 route에 유지한다. 상태 텍스트와 함께 기록 중지, captured 저장, ambiguous same-ID probe, 확인 후 재전송을 제공하며 full Recorder가 unmount돼도 숨기지 않는다. `녹음 버리기`는 원본과 복구 상태를 되돌릴 수 없이 지운다는 별도 확인을 거친다.
- Unsaved capture에서 non-scope navigation을 시도하면 modal dialog를 띄운다. 초기 focus는 `계속 녹음/현재 화면에 머물기`, Escape/cancel은 trigger로 focus를 복귀한다. Recording은 `기록 중지하고 머물기`, 유일한 destructive escape는 텍스트가 명시된 `녹음 버리고 이동`이다. 색만으로 파괴성을 전달하지 않는다.

### 홈(목록)
- **First-use readiness**: LLM health가 미설정이면 `회의록 요약을 준비하세요`, 저장 설정이 unavailable이면 `요약 모델을 확인하세요` card를 recorder 바로 앞에 둔다. 공통 copy는 요약 모델 없이도 녹음·로컬 전사가 가능하다고 명시한다. Primary **AI 요약 설정**은 Settings로 이동하고 secondary **요약 없이 회의 녹음**은 같은 화면 recorder로 scroll한 뒤 **회의 녹음 시작**에 focus한다. Route/modal tour/step persistence/account/recording gate는 만들지 않는다.
- 회의 카드 목록(제목·날짜·상태 라벨). **전역 처리 배너**는 `summary-work`의 전체 library aggregate로 요약 처리 중과 확인 필요를 분리하고, 확인 필요는 bounded attention detail로 연결한다. Terminal command를 active product action으로 안내하지 않는다.
- 빈 상태: "아직 회의록이 없습니다 — 첫 회의를 녹음해보세요" + 큰 녹음 버튼 + 3단계 안내(녹음 → 전사 → 요약 확인). Default All은 heading·border surface를 한 번만 렌더하고 onboarding을 같은 surface에 통합하며, folder/unfiled는 해당 scope copy만 한 번 표시한다.
- **상태 표시**: 색만으로 전달하지 않는다. whisper는 `Whisper {model} · 준비됨/준비 중/연결 안 됨`, 요약 모델은 `{Provider} {model?} · 연결됨/감지됨/미설정/실패`처럼 dot + 텍스트를 함께 표시한다. CLI provider(claude·codex)는 바이너리 감지라 “감지됨”, Ollama는 검증된 “연결됨”으로 라벨을 구분한다. 긴 모델명/오류는 truncate하고 full detail은 `title` 또는 설정 화면에서 확인한다. `baseUrl`은 사이드바에 노출하지 않는다.
- **전사 실패 row**: `retry_transcription`은 일반 `전사 중` label로 덮지 않고 error tone+text `전사 실패`를 지속 표시한다. Row detail href는 같은 meeting을 가리키며 상세에서도 persisted failure와 recovery action이 보여야 한다.
- **행 액션(케밥 ⋯ 메뉴)**: 각 회의 행 우측의 44px kebab 버튼(카드 링크 바깥 형제) → ready library에서는 **이동**, 요약 완료 회의는 **이름 수정**, 모든 회의는 **삭제**. Mobile row는 title/date/breadcrumb와 status를 세로로 reflow하고 content owner는 `w-full min-w-0`을 가진다. 이름 수정은 320px에서 full-width input + action row로 stack하고(Enter=저장, Esc=취소, Korean IME 조합 Enter 무시), 실패 시 값·입력 focus를 유지한다. 삭제 확인도 copy 아래 action row로 stack하며 취소에 initial focus를 둔다. 삭제 버튼은 파괴적 색뿐 아니라 `영구 삭제` text를 유지하고 저장/삭제 완료·실패는 `aria-live="polite"`로 공지한다.
- **Scoped list**: Workspace All row는 effective folder breadcrumb를 표시하고, 미분류/folder는 direct meeting만 표시한다. 이전/다음 cursor page를 제공하고 client는 current±2/max 5 pages만 유지한다. Empty copy는 All/미분류/folder를 구분한다.
- **Organization pending**: default workspace All의 별도 경고 section에 actual 위치 없는 pending/unavailable row, safe requested hint, detail-probe action을 표시한다. Canonical folder counts/list에 섞지 않고 모든 scope에서 persistent count link로 접근한다.
- **위치 선택기**: Meeting은 workspace 선택 뒤 미분류/folder를 검색하며 cross-workspace를 허용한다. Duplicate folder leaf는 workspace와 ancestor breadcrumb를 모두 표시한다. Folder 이동은 현재 workspace만 보이고 cross-workspace가 v1 비목표임을 설명하며 current/self/descendant/depth/name-conflict option을 이유와 함께 비활성화한다. Confirm 영역은 현재→목적지를 ID로 확정하며 409 뒤 selection을 지우고 최신 tree에서 다시 고르게 한다.
- **이동 후 초점·문맥**: Workspace All에 남은 row는 actual breadcrumb를 갱신한다. Filter에서 빠진 row는 next→previous→page heading 순으로 focus하고 이동 위치 link를 제공한다. Detail은 actual breadcrumb/back/sidebar source IDs를 갱신하되 attention cursor를 유지한다. Folder/descendant URL ID는 reparent 뒤에도 유지하고 새 ancestor를 펼친다.
- **Folder 삭제 후 보존**: `폴더 삭제`가 아니라 `폴더 삭제 후 보존` title을 사용한다. Preview에 direct visible meeting의 parent/unfiled 이동, affected/hidden-invalid placement, pending 위치 요청, child promotion을 항목별로 보이고 “회의 원본과 전사·요약 파일은 삭제하지 않습니다”를 고정한다. Promotion conflict는 충돌하는 두 folder 이름을 열거하고 rename/move 전에는 commit을 비활성화한다.
- **Workspace 삭제 후 보존**: 다른 destination workspace 선택과 정확한 source workspace 이름 입력이 모두 필요하다. 모든 meeting은 destination 미분류로 이동하고 source folder metadata만 제거됨을 표시한다. 마지막 workspace 버튼은 disabled + inline reason이다. Korean IME composition 중 Enter는 confirm하지 않는다.
- **Container 삭제 후 focus**: Cancel이 initial focus다. Current folder 삭제는 parent/unfiled heading, current workspace 삭제는 destination All heading으로 이동한다. Surviving descendant를 보고 있으면 URL ID와 heading을 유지하고 새 breadcrumb/ancestor만 갱신한다. 색·휴지통 icon만으로 meeting 영구 삭제와 혼동시키지 않는다.
- **손상 복구**: 모든 degraded mode는 read-only 목록, `다시 시도`, `데이터 폴더 열기`를 유지한다. `corrupt`에서만 `조직 정보 재구축`을 보이며 dialog initial focus는 취소다. Workspace/folder/color/order/placement 초기화, meeting artifact 보존, 손상 status meeting 누락 가능성을 항목별로 설명하고 exact `재구축` 입력을 Korean IME composition-safe하게 확인한다. Recording/capture/upload/retained Blob 중에는 action을 비활성화한다. 성공 copy는 발견 meeting 수와 path 없는 local archive 보존만 알리고 새 default All heading으로 focus한다. Unsupported/I/O/conflict/not-supported에는 rebuild가 없다.
- **Generation reset**: 새 `libraryId`는 revision `0` 숫자보다 먼저 세대 전환으로 처리한다. Page/entity/cursor, expanded folder, open drawer/dialog/form, optimistic move, summary-work/pending을 한 번에 폐기하고 stale scope URL과 detail source query를 server-resolved canonical ID로 replace한다. Old mutation/poll response는 공지나 row를 되살리지 못한다.
- **전역 요약 banner**: current page가 아닌 `summary-work` aggregate를 사용해 전체 library 처리 중/확인 필요를 표시한다. 확인 필요가 있으면 bounded attention cursor로 detail을 열고 next/end/explicit restart를 제공한다.
- **Recorder 위치 규칙**: 모든 ready/last-good scope에 start CTA를 보인다. Workspace All·미분류는 해당 workspace 미분류, folder는 exact folder를 시작 순간 snapshot한다. Last-good은 마지막 위치를 요청하지만 actual이 unavailable/fallback일 수 있음을, fresh global fallback은 `조직 위치 없이 저장`을 명시한다.
- **Finalize 결과 카드**: `원본 저장`·`회의 위치`·`재생 준비`·`전사`를 분리한다. Durable/best-effort/pending published 결과에는 재업로드 CTA를 두지 않는다. Fallback은 requested/actual breadcrumb와 이유를, non-null unavailable은 위치 재확인·대기 목록·reveal을, null unavailable은 actual 새로고침·reveal만 제공한다. Actual 위치 링크 이동 뒤 scope heading에 focus한다.

### 상세 (2탭)
- **정보 순서**: 목록으로 → 제목 → 날짜·상태 chip·위치 metadata → 이동/attention/lifecycle notice → utility action bar → `회의 정보`(audio·참석자) → tabs → 선택 panel 순서다. 제목은 action과 같은 flex row에서 폭을 경쟁하지 않고, metadata와 notice action은 mobile에서 wrap/stack한다.
- **Global action bar**: 상단 `회의 작업`에는 전역 동작인 **회의 이동 / 폴더 열기 / 회의록 다운로드(.md)**만 둔다. 복사·수정·재생성·JSON은 넣지 않는다. 모든 visible sibling은 rectangular radius, 최소 44px 높이, 같은 gap/alignment를 사용한다. 폴더 열기는 immediate success/failure를 `aria-live`로 알리며 detached OS viewer는 `열기 요청됨`까지만 표현한다.
- **회의 정보**: audio와 참석자 form은 긴 transcript 뒤가 아니라 action bar와 tabs 사이에 둔다. Mobile은 stack하고, 넓은 화면에서만 두 column `items-start`로 배치해 억지 equal-height 빈 공간을 만들지 않는다. 참석자 저장 실패는 입력을 보존한 inline status로 보이고, 성공 response의 검증된 participants를 reload 없이 copy/export에 즉시 반영한다. Parent refresh는 pristine field만 동기화하고 dirty draft를 덮지 않는다.
- **Tabs keyboard/ARIA**: 공유 horizontal controlled Tabs가 stable `tab`/`tabpanel` id, `aria-controls`/`aria-labelledby`, selected-only `tabIndex=0`과 panel 렌더를 소유한다. Left/Right는 wrap하며 automatic activation, Home/End는 first/last로 이동한다. Click도 선택+focus를 맞추고 Tab key는 가로 탐색 handler가 가로막지 않는다.
- **기본 tab**: URL에 explicit `contentTab=script|summary`가 있으면 그대로 연다. Query가 없고 usable summary가 있는 완료 회의는 **회의록 요약**, summary가 없으면 **전체 스크립트**를 기본으로 연다.
- **전사 실패 recovery**: `retry_transcription` detail은 safe failure copy와 **전사 다시 시도**를 보여 준다. 요청 중에는 **전사 요청 중…**으로 disable하고 accepted/already-running 뒤 최신 상태를 다시 확인한다. 실패 copy는 원본 보존과 다음 행동만 말하고 path/dispatch/provider output을 노출하지 않는다. Polite status를 알리고 완료 뒤 trigger로 focus를 돌린다. Polling은 single in-flight이며 timeout 자체를 실패로 표시하지 않는다.
- **Tab-local action bar**: 각 selected tabpanel은 `tablist → tab-local action/status → 요약 갱신 경고(해당할 때) → 읽기 본문 또는 editor` 순서다. 전체 스크립트는 **전체 스크립트 복사 / 전체 스크립트 수정 / 원문에서 스크립트 다시 만들기**, 회의록 요약은 **요약 복사 / JSON 다운로드 / 회의록 요약 수정 / 현재 스크립트로 요약 다시 만들기** 순서를 고정한다. 최초 교정 전 fallback은 `교정 전 원문 · 자동 전사`로 표시해 빈 탭을 만들지 않는다. 제목과 참석자는 summary editor에서 바꾸지 않고 각각 기존 제목 수정과 `회의 정보` 참석자 입력을 사용한다.
- **본문 교체형 editor**: 수정 중에는 저장된 읽기 본문을 아래나 옆에 남기지 않고 같은 content region을 editor로 교체한다. 전체 스크립트는 하나의 multiline textarea로 현재 교정본을 lossless하게 편집한다. CRLF만 LF로 정규화하고 비어 있거나 UTF-8 1 MiB 초과면 입력에 focus한 채 저장을 막는다. Helper는 “교정된 스크립트만 바뀌며 녹음 원본과 자동 전사 원문은 유지됩니다”를 명시한다.
- **회의록 요약 editor**: visible `회의록 요약 본문` label과 helper, resizable multiline textarea 하나만 제공한다. Generated structured summary는 읽기 순서와 같은 `요약`(oneLine 뒤 highlight bullet) → `목적` → `논의 내용` → `결정 사항` → `액션 아이템` → `리스크` → `후속 확인` plain text로 시작하며 빈 section은 생략한다. Block 사이는 LF 두 개이고 trailing LF가 없다. Existing manual body는 그대로 시작한다. Heading·bullet은 모두 삭제 가능한 일반 text이고 item 내부 개행도 parse·trim·재구성하지 않는다. 표시 제목·topicSlug·participants는 textarea에 넣지 않는다.
- **요약 입력 validation**: Whitespace-only와 exact `{expectedRevision,body}` serialized PATCH의 UTF-8 byte length가 512 KiB를 넘는 입력은 network 전에 막는다. Body byte 정보를 textarea helper/status와 연결하고 구체적 오류 뒤 textarea에 focus하며 exact draft를 유지한다. CRLF만 LF로 정규화한다.
- **요약 최신성**: 전체 스크립트 저장·재생성 뒤 기존 요약은 삭제하지 않는다. 달라진 경우 tab label을 `회의록 요약 · 요약 갱신 필요`로 바꾸고 panel 상단에 **요약 갱신 필요 → 전체 스크립트가 변경되었지만 기존 요약은 유지됨 → 회의록 요약을 수정하거나 현재 스크립트로 다시 만들 수 있습니다** 순서로 표시한다. Summary 직접 저장 또는 현재 스크립트 기준 재생성 뒤 warning을 제거한다. 요약 복사와 combined Markdown에는 warning을 포함한다. JSON은 현재 저장된 summary schema를 그대로 내려받으므로 link를 warning에 연결하고 “스크립트보다 오래된 내용일 수 있음”을 설명한다.
- **저장 state machine**: `editing → saving → verifying? → saved|validation|conflict|error|ambiguous`다. Saving은 `저장 중…`, 응답이 없거나 성공 body가 검증되지 않으면 `저장 여부 확인 중…`을 알리고 read-only probe를 사용한다. Busy primary label은 `저장 확인 중…`이며 입력과 cancel을 disable한다. 성공은 `저장됨`, committed durability pending은 `저장됨 · 디스크 동기화 확인 대기`다. 저장되지 않음이 확인되면 draft를 유지하고 같은 저장을 다시 시도할 수 있다.
- **Confirmed action과 tab 문맥**: Editor가 열려도 복사·JSON·combined Markdown 다운로드는 textarea draft가 아닌 마지막 confirmed 저장본을 사용하고 action 아래 polite status가 이를 명시한다. 같은 수정 trigger는 `수정 중` disabled state로 보여 silent no-op을 만들지 않는다. 소유 tab label은 idle/error/conflict/missing=`수정 중`, saving=`저장 중`, verifying=`저장 확인 중`, ambiguous=`저장 확인 필요`를 표시하며 summary의 `요약 갱신 필요` token과 exact draft를 다른 tab에 갔다 돌아와도 유지한다.
- **저장 오류·복구**: Validation/413은 exact draft와 textarea focus를 유지하고 길이를 줄여 재시도하게 한다. Missing/deleted meeting은 더 저장할 수 없음을 밝히고 **내 입력 복사**를 제공한다. 다른 content operation은 draft를 유지하고 작업 종료 뒤 같은 입력으로 재시도하게 한다. Revision conflict는 “다른 변경이 먼저 저장됐습니다”와 **내 입력 복사 / 최신 내용 불러오기**를 제공하고, 실제 교체 전 “현재 입력을 버리고…” 확인과 **최신 내용으로 교체 / 취소**를 한 번 더 요구한다. Source conflict·ambiguous는 draft를 유지하고 복사·새로고침/폴더 확인의 fail-closed recovery만 제공한다. Network/invalid 2xx는 read-only probe로 intended/predecessor/third/unavailable을 판정하며 blind PATCH retry를 하지 않는다. 일반 unavailable은 draft와 focus를 유지한다.
- **독립 재생성 dialog**: `전체 스크립트 다시 만들기`는 “자동 전사 원문에서 교정된 전체 스크립트를 다시 만듭니다. 현재 스크립트는 대체되고 기존 요약은 유지되지만 요약 갱신이 필요할 수 있습니다.”, `회의록 요약 다시 만들기`는 “현재 저장된 전체 스크립트로 회의록 요약만 다시 만듭니다. 스크립트는 바뀌지 않고 현재 수동 요약은 대체됩니다.”를 사용한다. Action은 각각 **취소 / 스크립트 다시 만들기**, **취소 / 요약 다시 만들기**다. 취소가 initial focus이고 Escape/backdrop 취소는 trigger로 focus를 복귀한다. Request/생성 중에는 dialog dismiss와 두 action을 모두 막고 현재 저장된 pair는 계속 읽기·복사·다운로드할 수 있게 한다.
- **취소·Unsaved navigation guard**: Dirty cancel과 다른 editor 전환은 inline discard 확인을 먼저 열고 **계속 수정**을 첫 control과 focus/announcement 대상으로 둔다. Continue는 same textarea/draft/focus를 유지하고 explicit **수정 내용 버리기** 뒤에만 confirmed body를 복원한다. Dirty content editor는 목록 링크, rail/drawer, guarded router, browser back/forward와 `beforeunload`를 같은 layout-level blocker로 보호한다. Same meeting pathname의 query-only 이동만 허용한다. Content만 있으면 `수정 내용이 저장되지 않았습니다`, unsaved audio도 있으면 `녹음과 수정 내용이 저장되지 않았습니다` dialog에 잃을 항목을 함께 열거한다. **계속 편집**이 initial focus이고 dirty일 때만 **수정 내용 버리고 이동** 또는 **녹음과 수정 내용 버리고 이동**을 제공한다. Cancel 뒤 원 trigger로 focus를 돌린다.
- **Saving/verifying navigation**: 이동 요청을 pending으로 유지하고 “저장 결과를 확인한 뒤 이동합니다”를 표시한다. 이때 discard action은 없으며 Escape/cancel은 현재 화면에 머문다. 저장 성공으로 blocker가 사라지면 pending navigation을 한 번 commit하고, 실패가 dirty로 돌아오면 그때 discard 선택을 제공한다. Ambiguous가 해소되지 않으면 이동하지 않는다.
- **Responsive action·focus**: Desktop과 mobile 모두 tab-local action은 content 앞에서 `flex-wrap`하고 최소 44px target, visible focus ring, `min-w-0`/break rules를 유지한다. 320px에서는 tab label과 action이 여러 줄·여러 행으로 자연스럽게 reflow하되 horizontal scroll을 만들지 않는다. Editor를 열면 textarea, save 성공/cancel 뒤에는 해당 수정 trigger, generation dialog 취소 뒤에는 generation trigger로 focus를 돌린다.

#### 수동 편집 browser 검증 기준

- ADR 0020의 repository-owned synthetic Playwright scenario는 `desktop-1440`(1440×900), `mobile-390`(390×844), `mobile-320`(320×700)에서 같은 계약을 검증해야 한다. Runner-owned 임시 snapshot과 empty data만 사용하고 실제 사용자 데이터·Whisper/LLM·외부 network를 사용하지 않는다.
- 세 viewport에서 tab-local action이 warning/body/editor보다 앞서는 DOM 순서, 최소 44px target, read/edit mutual exclusion, summary heading text 삭제와 exact save, confirmed-copy 안내, discard의 **계속 수정** focus, cancel 뒤 original restoration, transcript 저장 뒤 outdated와 summary 저장 뒤 fresh 전환, horizontal overflow 0을 assertion으로 남긴다.
- Evidence는 성공 screenshot, assertion 결과, console error, viewport/fixture manifest를 `test-results/` 또는 execute local journal에 남긴다. 실제 실행 결과가 생성되기 전에는 이 문서가 pass를 선언하지 않는다.

### 단어 관리(단어장)
- **2탭**(각 탭 카운트 표기): **일반 용어** / **교정쌍**. 상단 1줄 설명(브랜드명 미포함).
- 일반 용어: 쉼표(`,`/`，`)·개행으로 일괄 추가(**공백 분리 금지** — "프로덕트 로드맵" 같은 다어절 용어 보존), 제거 가능한 chip(`aria-label="용어 삭제: {term}"`).
- 교정쌍: **잘못 인식된 표기(전) → 올바른 표기(후)** 두 필드(둘 다 필수, `trim` 후 비어있지 않아야 추가 활성). 320–375px에서는 보이는 전/후 label과 input을 세로로 쌓고 `sm` 이상에서만 한 줄로 둔다. 결과의 긴 전/후 값은 truncate하지 않고 wrap한다. 중복 `from`·`from===to`는 스킵/경고.
- 저장 모델: **명시적 "저장" 버튼**(자동저장 아님). 두 탭은 로컬 state로 함께 편집되고 하단 단일 버튼으로 1회 저장. 변경 시 "변경됨", 저장 후 "저장됨", 실패 시 `role="status"` 인라인 에러(로컬 state 보존).
- Initial GET은 `loading|ready|load_error`를 구분한다. Non-2xx·network·invalid body는 빈 단어장으로 낮추지 않고 editor/replace-save를 잠근 뒤 재시도를 제공한다. 저장은 `ready && dirty && !saving`에서만 가능하고 성공 body로 정규화하며 실패 시 draft를 보존한다.
- 안내: "새 회의는 자동 반영 · 기존 회의는 상세의 '원문에서 스크립트 다시 만들기'로 교정본 갱신". 단어장은 summary-only 생성에는 적용되지 않는다.

### 설정 화면 · 내 정보

- Settings page는 `<main>`과 `h1 "설정"`을 하나씩만 가진다. `요약 모델`을 먼저, `내 정보`를 다음 sibling section으로 둔다. 각 section의 loading/load error/dirty/saving/saved/pending/save error는 다른 section의 편집과 상태를 가리거나 막지 않는다.
- `내 정보`는 선택 설정이다. 제목 바로 아래에서 ‘내 할 일’·상대 날짜 개인화를 보완하지만 일반 검색/질문의 필수 조건은 아님을 설명한다. 표시 이름과 쉼표/줄바꿈 별칭은 첫 group에 보이고, timezone/주 시작 요일은 기본이 닫힌 native `날짜 기준` disclosure에 둔다. 사용자가 열었거나 검증 오류가 있는 disclosure를 저장/상태 갱신 때문에 임의로 닫지 않는다.
- First-use에서는 **내 정보가 없어도 녹음·전사·일반 검색을 사용할 수 있습니다**를 명시한다. Dormant 질문 기능을 현재 활성 pipeline처럼 소개하지 않는다.
- Missing profile의 timezone은 local runtime default 또는 판정 불가 시 `UTC`로 제안하되 `아직 저장되지 않음`을 함께 표시한다. IANA 값을 직접 입력할 수 있고 native datalist가 가능한 환경에서는 bounded suggestion만 제공한다. Pending durability는 실패/재저장 CTA가 아니라 `저장됨 · 디스크 동기화 확인 대기` committed warning으로 표시한다.
- 320px에서는 두 section 모두 field와 action/status를 한 열로 reflow하고 timezone·별칭·CJK 장문이 action과 폭을 경쟁하거나 horizontal overflow를 만들지 않는다.

### 요약 모델 설정
- Initial GET은 `loading|ready|load_error`를 구분한다. `{provider:null}`만 명시적 미설정 ready이며, read 실패를 기본 Claude 설정으로 가장하지 않고 editor/save를 잠근 뒤 재시도를 제공한다.
- Server-confirmed `savedSnapshot`과 editable draft를 분리한다. Provider/model/baseUrl을 정규화해 비교하고 저장은 `ready && dirty && valid && !saving`에서만 활성화한다. Save 실패는 draft/dirty를 보존하고 성공 body로 snapshot과 draft를 함께 맞춘다.
- **Native selector**: Claude CLI는 **CLI 기본값 (권장) / Sonnet / Opus / Haiku / 직접 입력**, Codex CLI는 **CLI 기본값 (권장) / 직접 입력**만 제공한다. Empty default는 model field를 저장하지 않는다. Ollama는 draft loopback Base URL의 설치 model을 select에 표시하고 **설치된 모델 새로고침 / 직접 입력**을 제공한다. 설치 model이 없거나 discovery가 실패해도 자동 pull/download하지 않고 custom 입력을 유지한다.
- Unknown stored model은 **직접 입력**으로 exact 표시한다. Custom은 save 직전 trim한 exact identifier를 전달하며 alias 보정/fuzzy matching을 약속하지 않는다. Provider를 바꿔도 session 안 각 provider의 selection/custom/Base URL draft를 보존하고 다른 provider model을 조용히 재사용하지 않는다.
- Ollama 선택 직후에는 required 표시와 neutral helper만 보인다. Model blur 또는 submit 시도 뒤에만 red error·`aria-invalid`·error relation을 연결하고 CLI provider로 바꾸면 Ollama-only error를 지운다.
- 저장 성공 직후 persisted snapshot health를 자동 검사한다. Claude/Codex success는 **감지됨**으로 CLI binary만 확인하며 인증이나 실제 요약 성공을 보장하지 않는다. Ollama success는 선택 model이 설치된 loopback service에 **연결됨**을 뜻한다. 성공하면 **첫 회의 녹음** action을 제공하고 실패하면 saved snapshot과 provider별 draft를 유지한 채 설치/PATH 또는 Ollama 실행/model 조치를 보여 준다.
- `연결 테스트`는 화면의 미저장 draft가 아니라 디스크에 저장된 설정을 검사한다. Loading/load error, 미설정, dirty, saving/testing 동안 disabled reason을 보여 주며 결과에는 검사한 provider/model만 표시하고 `baseUrl`은 표시하지 않는다.

#### 설치·첫 실행 상태 matrix

| Surface | 상태 | 필수 UX |
|---|---|---|
| Home readiness | health loading / ready / unconfigured / unavailable | loading·ready면 card 없음, 나머지는 비차단 설정+recorder focus, recorder enabled |
| Model selector | known / unknown custom / provider switch / Ollama loading·empty·error | exact draft 보존, native select, 44px refresh, no auto download |
| Persisted health | saving / checking / CLI detected / Ollama connected / unavailable | save snapshot 보존, 정직한 provider별 문구, success recorder action |
| Transcription recovery | list failure / detail failure / requesting / accepted / safe error | persistent `전사 실패`, one request, disabled busy label, status+focus return |

Readiness card, selector/refresh, retry action, recorder CTA는 320px에서 한 열 또는 wrap으로 reflow하고 horizontal overflow를 만들지 않는다. 독립 control은 최소 44px target과 visible focus를 유지한다.

## 접근성
- 상태 변화는 `aria-live="polite"`로 안내("기록 중"·"전사 완료"). `prefers-reduced-motion` 존중. 소형 텍스트에 `#9A8F84` 금지(대비).
- Polling되는 전사·요약 system row는 같은 label 재렌더를 live text mutation으로 만들지 않고, 준비/실패처럼 화면 label이 실제로 바뀔 때만 공지한다.
- **앱 셸**: `<nav aria-label="라이브러리">` 랜드마크 하나, 활성 항목에 `aria-current="page"`. 상시 nav 때문에 매 페이지 맨 앞에 **skip-to-content 링크**(`href="#main"`, 포커스 시에만 표시), DOM 순서 skip link → nav → main wrapper.
- **녹음 이탈 guard**: `role="dialog" aria-modal="true"`, 제목 연결, cancel initial focus, Escape/cancel trigger focus 복귀. Compact/dialog action target은 최소 44px이며 destructive action은 아이콘/색 외에 `버리기` 문구를 반드시 포함한다.

### Modal/drawer lifecycle

- Nested drawer/dialog는 browser top-layer 순서를 따른다. Escape는 최상단 surface의 native `cancel`만 처리하며, backdrop은 panel 밖에서 시작하고 끝난 명시적 click만 dismiss한다.
- Mutation 중인 surface는 Escape·backdrop·cancel로 닫히지 않으며 실제 cancel control도 disabled한다. 실패하면 dialog, 입력값, 선택과 현재 focus를 유지한다.
- Cancel/Escape/backdrop은 connected trigger로 focus를 돌리고, trigger가 사라졌으면 아래 surface의 safe control/heading 또는 page heading을 사용한다. Create/delete/rebuild처럼 navigation이나 generation이 바뀐 성공은 stale trigger 대신 새 scope heading으로 명시적으로 handoff한다. Browser back/forward에는 destination focus를 강제하지 않는다.

| Surface | Initial focus |
|---|---|
| Workspace/folder create·rename·edit | Name input |
| Meeting move | Workspace select, 없으면 folder search |
| Folder move | Folder search |
| Folder/workspace preservation delete | Cancel |
| Corrupt library rebuild | Cancel |
| Recorder navigation guard | 계속 녹음/현재 화면에 머물기 |
| Recorder permanent discard | 유지하기 |
| Mobile drawer | Close button 또는 첫 navigation control |
