# 0009 — 재요약 비동기화(202) + 실패 가시성 + 생성 타임아웃 600초

- **날짜:** 2026-07-10
- **상태:** 채택됨

## 무엇을 결정했나
수동 "다시 요약"의 신뢰성 3종을 함께 고친다.
- **비동기화**: `POST /api/meetings/[id]/summarize`는 동기 사전검증(400/404/409/no_model) 후 `runSummarize(force)`를 논-await로 발사하고 **202**를 즉시 반환한다.
- **완료 감지(인플라이트 락 기반)**: `deriveStatus`가 옛 `summary.json` 존재로 재요약 중 `summarizing`을 `summarized`로 가리므로 `status.status`로는 완료를 못 본다. 상세 페이지가 `isSummarizeInflight(id)`를 `resummarizeInflight` prop으로 노출하고, 클라이언트는 202 후 로컬 "요약 중" + 3초 `router.refresh()`로 폴링하며 판정한다 — **요약 내용 변경=성공(즉시)** / **인플라이트 락을 관측한 뒤 해제되면: `retry_summary` 에러면 실패·아니면 성공(내용이 동일해도)** / **~30분(생성 3콜 상한 초과)=타임아웃 폴백**. 락 관측 전의 stale prop(옛 에러/미기동)은 완료로 오인하지 않게 게이트한다.
- **진행 중 표시(cold entry)**: 진행 여부는 `resummarizing`(이 탭의 낙관 플래그) **OR** `resummarizeInflight`(서버 락)로 파생한다. 그래서 재요약 중 페이지를 새로 열어(로컬 플래그 없음) 서버 락만 true여도 상단 badge는 "요약 생성 중", StatusCard는 스피너, "다시 요약"/"재시도" 버튼은 비활성으로 보이고 완료 시 자동 갱신된다. 워커 첫 요약도 같은 락에 잡히므로 폴링을 하나로 통합했다(타임아웃 상한은 로컬 시작 재요약에만 적용).
- **실패 가시성/상태 정합**: 재요약(force) 실패 시 `summary.json`이 있으면 `transcribed`로 강등하지 않고 `summarized`를 유지 + `retry_summary` 에러 첨부(옛 요약 보존). `deriveStatus`는 `summarized` 승격 시 `retry_summary` 에러를 **보존**하고 그 외 에러만 정리한다.
- **생성 타임아웃**: 교정·요약 호출에 고정 `LLM_GENERATION_TIMEOUT_MS = 600_000`(10분). 헬스체크·`exec.ts` 기본값(120초)은 유지. 재요약은 순차 최대 3콜(교정→요약→폴백 요약)이라 클라이언트 타임아웃 폴백은 `3×600s+30s`로 서버 최악 예산 위에 잡는다.

## 왜
- **타임아웃**: 88분(약 3.6만 자) 회의의 교정 단계는 전사를 통째로 재출력해 120초 기본값에 SIGKILL된다(`status.json`에 `"process timed out after 120000ms"` 실측). env 설정 대신 고정 상수 — 불필요한 설정성 금지.
- **동기 블로킹 제거**: 기존 라우트는 요청 안에서 `await runSummarize`로 수 분을 붙잡아 브라우저 타임아웃/502를 유발했다. 최초 요약이 워커+폴링으로 도는 것과 대칭이 되도록 재요약도 발사-후-폴링으로 맞춘다.
- **조용한 실패 제거**: 비동기화 후 실패가 `deriveStatus`(GET가 파생 상태를 persist)에서 `summary.json` 존재 시 `error:null`로 지워져 사용자에게 전혀 안 보였다. 상태를 `summarized`로 유지 + 에러 보존으로 배너를 살린다. 옛 요약을 강등하지 않으니 데이터 손실 없이 재시도 가능.
- **완료 감지를 클라이언트로 + 인플라이트 락 신호**: `deriveStatus`가 옛 `summary.json` 존재로 재요약 중 `summarizing`(rank4)을 `summarized`(rank5)로 가려, 기존 `status==="summarizing"` 폴링이 재요약에선 작동하지 않는다. 백엔드 파생 의미를 바꾸면(예: `summarizing` 우선) 크래시 스턱 위험이 생긴다. 그래서 이미 존재하는 `isSummarizeInflight`(globalThis Set, DELETE 라우트가 이미 크로스-라우트로 사용)를 상세 페이지가 prop으로 노출해, "락 관측 후 해제"를 완료 신호로 쓴다. 내용 변경만으로 판정하면 **동일 내용 재생성 시 성공을 못 잡고**(빈 단어장 변경·저온 로컬 모델) 타임아웃까지 hang하는 결함이 있어(적대 리뷰에서 확인) 락 신호를 1차 신호로 두고 내용 변경은 빠른-성공 경로로 병행한다.
- **타임아웃 폴백을 서버 예산 위로**: 한 번의 재요약은 순차 최대 3콜(교정+요약+폴백 요약)이라 서버 최악 예산 ≈ 3×600s. 클라이언트 데드라인을 610s(1콜 기준)로 두면 긴 회의(F2가 겨냥한 바로 그 입력)에서 서버가 아직 도는 중에 조기 오탐 타임아웃이 난다(적대 리뷰에서 확인). `RESUMMARIZE_TIMEOUT_MS = 3×600s+30s`로 예산 위에 잡되, `exec.ts`는 `node:child_process`를 끌어와 클라이언트 번들을 오염시키므로 상수를 import하지 않고 동일 파생식으로 미러링한다.

## 버린 대안
- **동기 유지 + 타임아웃만 상향**: 사용자가 여전히 수 분 블로킹. 브라우저/프록시 타임아웃에 취약.
- **`deriveStatus`에서 `summarizing`을 `summarized`보다 우선**: 크래시로 `summarizing`이 남으면 영구 스턱. 파생을 파일-존재 단조 승격으로 두는 계약(ADR 0003) 위반.
- **완료 감지를 요약 내용 변경만으로**: 동일 내용 재생성 시 성공 신호가 없어 타임아웃까지 hang. 인플라이트 락을 병행해 해소.
- **클라이언트 데드라인 610s(1콜 기준)**: 순차 2~3콜 구조와 어긋나 긴 회의에서 오탐 타임아웃. 3콜 예산으로 상향.
- **재요약 실패 시 `transcribed` 강등 유지**: 옛 요약이 살아있는데 상태만 뒤처지는 모순 + 강등 후 재시도가 force 없이 409로 막힘.
- **타임아웃을 env 설정으로**: 단일 사용자 로컬 앱에 불필요한 설정 표면.

## 영향받는 곳
- `src/services/llm/exec.ts`(`LLM_GENERATION_TIMEOUT_MS`), `src/services/llm/claudeCli.ts`·`codexCli.ts`·`ollama.ts`(생성 호출에 주입).
- `src/lib/summarize.ts`(실패 핸들러: 요약본 있으면 `summarized` 유지), `src/lib/status.ts`(`deriveStatus` 에러 보존).
- `src/app/api/meetings/[id]/summarize/route.ts`(동기 사전검증 + fire-and-forget + 202), `src/app/meetings/[id]/page.tsx`(`resummarizeInflight` prop 노출), `src/components/MeetingDetailView.tsx`(인플라이트 락 기반 완료 폴링 + 타임아웃 폴백 + "재요약 실패" 배너).
- 테스트 seam: `src/services/llm/fake.ts`(`FAKE_LLM_FAIL=1` → `run()` throw).
- **미결(F4, 연기)**: 교정이 전사를 재출력하는 구조라 회의가 길수록 시간·토큰이 선형 증가 — 몇 시간짜리는 600초로도 위태롭다. 청킹/교정 생략은 별도 이슈.
- **알려진 한계(minor)**: 재요약 실행이 폴 간격(3초)보다 빨리 실패하면 락을 관측하지 못해 실패를 즉시 못 잡고 타임아웃/수동 새로고침으로 드러난다. 실제 LLM 호출은 3초를 넘겨 현실 확률이 낮아 별도 처리하지 않는다.
