# 0007 — 회의 삭제는 폴더 전체 영구 삭제(rename-then-rm)

- **날짜:** 2026-07-09
- **상태:** 채택됨

## 무엇을 결정했나
회의록 삭제는 `data/meetings/{id}/` 폴더 전체를 **영구 삭제**한다(휴지통/보관 없음). 삭제는 `rename(dir, ".trash-{id}-{ts}")` 후 `rm -rf`의 2단계로 한다. 요약이 인플라이트(`isSummarizeInflight`)인 회의만 삭제를 막고(409), 그 외 모든 상태(recorded/transcribed/summarized/error/멈춤)는 지울 수 있다.

## 왜
- **좀비 부활 방지**: `atomicWriteFile`이 매 쓰기마다 `mkdir -p`를 하므로, 삭제 직후 진행 중이던 producer가 폴더를 되살릴 수 있다. 먼저 `.`(dot) 프리픽스 이름으로 rename하면 `isSafeId`가 그 이름을 거부(→ `listMeetingIds` 제외)하므로, 느리거나 부분적인 `rm` 도중에도 반쪽 회의가 목록에 보이지 않는다.
- **인플라이트만 게이트**: status.json을 재생성하는 가장 확실한 부활원은 요약 워커/수동 재요약이다. 같은 Node 프로세스가 공유하는 이 인플라이트 플래그만 신뢰성 있게 차단하면 충분하다. 멈춘/실패 회의는 지울 수 있어야 하므로 상태로 막지 않는다.
- **단일 writer 불변**: 삭제는 부분 쓰기가 아니라 레코드 폐기이므로, whisper·요약 워커 소유 파일까지 함께 지워도 소유권 규칙과 충돌하지 않는다(app-api가 레코드 수명주기를 관장).

## 버린 대안
- **소프트 삭제(휴지통 + 스윕 워커)**: 상태 있는 무빙파트가 늘어나 로컬 단일 사용자에 과함(YAGNI). `.trash-*` 잔여물은 드문 rm 실패 시에만 남고 목록엔 안 보이므로 수용.
- **모든 상태 삭제 허용(인플라이트 포함)**: 삭제와 요약 write가 경쟁해 orphan status.json이 남을 수 있어 배제.

## 영향받는 곳
- `src/app/api/meetings/[id]/route.ts`(DELETE), `src/lib/summarize.ts`(`isSummarizeInflight`), `src/lib/atomicWrite.ts`(mkdir 재생성 특성), `src/lib/status.ts`(`listMeetingIds`의 `isSafeId` 필터).
- 잔여 위험(수용): 삭제 게이트는 요약 인플라이트만 막고 **전사(transcribing) 중 삭제는 허용**한다(멈춘 전사도 지울 수 있어야 하므로 — 별도 Node 프로세스인 whisper 잡을 신뢰성 있게 취소할 수단이 없다). 그 결과 whisper가 삭제 직후 raw.md/segments.json을 쓰면 status.json 없는 **invisible orphan dir**(전사본 포함)가 남을 수 있다. 목록/GET에는 안 보이지만 디스크엔 잔존 — 로컬 단일 사용자 환경에서 허용하며, 필요 시 후속으로 기동 시 orphan/`.trash-*` 스윕을 추가한다(v1 제외, YAGNI).

## 곁들임 — 내보내기물 scrub 미적용(의도된 결정)
`AGENTS.md`는 "요약·내보내기물에 PII/토큰/URL scrub"을 CRITICAL로 적었으나, 로컬 단일 사용자 hand-off 문서(`export`의 `.md`/`.json`)에는 **scrub을 적용하지 않는다**(현재 미구현). 이유: 내보내기 대상은 이미 `data/`만큼 신뢰되는 로컬 파일이고, 단어장(`glossary.json`)에 사람 이름이 들어갈 수 있어 정규 표기를 오히려 보존해야 하며, 자동 scrub은 회의록 본문(숫자·이름)을 손상시킬 위험이 크다. 실제 scrub 구현은 별건(사용자 미요청)으로 두고, `AGENTS.md`/`SECURITY.md` 문구를 이 현실에 맞게 정렬했다.
