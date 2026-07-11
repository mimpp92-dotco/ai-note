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
- **앱 셸**: desktop `lg` 이상은 약 272px library rail(`border-r border-line`, `bg-chrome`) + 콘텐츠(`flex-1 min-w-0`). Mobile/tablet은 64px top bar와 `h-dvh` modal drawer를 사용한다. Modal dialog/drawer는 native `<dialog>.showModal()` browser top layer를 사용해 background inert와 focus containment를 얻고, app-level ref-count scroll lock으로 body 스크롤을 막는다. Native dialog가 아닌 popup만 별도 layer를 쓴다.
- **Library rail 구조**: identity → workspace switcher/create/rename → `모든 회의`/`미분류` → 독립 scroll folder section → 위치 저장 대기/단어 관리/설정 → shared 전사·요약 health. 프로필/팀/권한/템플릿/사용량 위젯은 없다.
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

### 녹음 화면
- 상단 우측 **다크 "실시간 기록 시작"** 버튼. 녹음 중: 펄스 red dot + "기록 중" + `mm:ss` 타이머(mono) + **레벨 미터**(입력 소리 확인). 마이크 무음 시 레벨 0 = 사용자가 문제 인지. 페이지 이탈 시 `beforeunload` 경고.
- Non-idle 녹음 session은 layout 우하단 compact control(`min-height:44px`)로 모든 route에 유지한다. 상태 텍스트와 함께 기록 중지, captured 저장, ambiguous same-ID probe, 확인 후 재전송을 제공하며 full Recorder가 unmount돼도 숨기지 않는다. `녹음 버리기`는 원본과 복구 상태를 되돌릴 수 없이 지운다는 별도 확인을 거친다.
- Unsaved capture에서 non-scope navigation을 시도하면 modal dialog를 띄운다. 초기 focus는 `계속 녹음/현재 화면에 머물기`, Escape/cancel은 trigger로 focus를 복귀한다. Recording은 `기록 중지하고 머물기`, 유일한 destructive escape는 텍스트가 명시된 `녹음 버리고 이동`이다. 색만으로 파괴성을 전달하지 않는다.

### 홈(목록)
- 회의 카드 목록(제목·날짜·상태 라벨). **처리 대기 배너**: `transcribed`(교정 대기) 회의가 있으면 상단에 "N개 회의 교정 대기 — 터미널에서 `/meeting-summarize` 실행" + 복사 버튼.
- 빈 상태: "아직 회의록이 없습니다 — 첫 회의를 녹음해보세요" + 큰 녹음 버튼 + 3단계 안내(녹음 → 전사 → 요약 확인). Default All은 heading·border surface를 한 번만 렌더하고 onboarding을 같은 surface에 통합하며, folder/unfiled는 해당 scope copy만 한 번 표시한다.
- **상태 표시**: 색만으로 전달하지 않는다. whisper는 `Whisper {model} · 준비됨/준비 중/연결 안 됨`, 요약 모델은 `{Provider} {model?} · 연결됨/감지됨/미설정/실패`처럼 dot + 텍스트를 함께 표시한다. CLI provider(claude·codex)는 바이너리 감지라 “감지됨”, Ollama는 검증된 “연결됨”으로 라벨을 구분한다. 긴 모델명/오류는 truncate하고 full detail은 `title` 또는 설정 화면에서 확인한다. `baseUrl`은 사이드바에 노출하지 않는다.
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
- **Action bar**: Ready library의 회의 이동과 요약 복사·전사 복사·Markdown/JSON 다운로드·폴더 열기·다시 요약을 한 `회의 작업` group으로 묶는다. 모든 visible sibling은 rectangular radius, 최소 44px 높이, 같은 gap/alignment를 사용한다. 재요약 확인/error panel은 group 바로 아래에 열리고 busy 중 confirm/cancel을 막는다. 복사와 폴더 열기는 immediate success/failure를 `aria-live`로 알리며 detached OS viewer는 `열기 요청됨`까지만 표현한다.
- **회의 정보**: audio와 참석자 form은 긴 transcript 뒤가 아니라 action bar와 tabs 사이에 둔다. Mobile은 stack하고, 넓은 화면에서만 두 column `items-start`로 배치해 억지 equal-height 빈 공간을 만들지 않는다. 참석자 저장 실패는 입력을 보존한 inline status로 보이고, 성공 response의 검증된 participants를 reload 없이 copy/export에 즉시 반영한다. Parent refresh는 pristine field만 동기화하고 dirty draft를 덮지 않는다.
- **Tabs keyboard/ARIA**: 공유 horizontal controlled Tabs가 stable `tab`/`tabpanel` id, `aria-controls`/`aria-labelledby`, selected-only `tabIndex=0`과 panel 렌더를 소유한다. Left/Right는 wrap하며 automatic activation, Home/End는 first/last로 이동한다. Click도 선택+focus를 맞추고 Tab key는 가로 탐색 handler가 가로막지 않는다.
- **전체 스크립트** 탭: 교정본(`transcript.md`). 아직 교정 전이면 raw를 "교정 전 원문 · 자동 전사"로 표시(전사 후 빈 탭 금지). 세그먼트 타임스탬프 표시.
- **회의록 요약** 탭: `summary.json` 렌더(요약/목적/논의/결정/액션아이템/리스크/후속) + **내보내기(export) 버튼**.

### 단어 관리(단어장)
- **2탭**(각 탭 카운트 표기): **일반 용어** / **교정쌍**. 상단 1줄 설명(브랜드명 미포함).
- 일반 용어: 쉼표(`,`/`，`)·개행으로 일괄 추가(**공백 분리 금지** — "프로덕트 로드맵" 같은 다어절 용어 보존), 제거 가능한 chip(`aria-label="용어 삭제: {term}"`).
- 교정쌍: **잘못 인식된 표기(전) → 올바른 표기(후)** 두 필드(둘 다 필수, `trim` 후 비어있지 않아야 추가 활성). 중복 `from`·`from===to`는 스킵/경고.
- 저장 모델: **명시적 "저장" 버튼**(자동저장 아님). 두 탭은 로컬 state로 함께 편집되고 하단 단일 버튼으로 1회 저장. 변경 시 "변경됨", 저장 후 "저장됨", 실패 시 `role="status"` 인라인 에러(로컬 state 보존).
- 안내: "새 회의는 자동 반영 · 기존 회의는 상세의 '다시 요약'으로 갱신".

## 접근성
- 상태 변화는 `aria-live="polite"`로 안내("기록 중"·"전사 완료"). `prefers-reduced-motion` 존중. 소형 텍스트에 `#9A8F84` 금지(대비).
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
