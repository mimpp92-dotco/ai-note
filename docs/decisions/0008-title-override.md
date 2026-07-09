# 0008 — 표시 제목은 titleOverride로 app-api가 소유(override 우선)

- **날짜:** 2026-07-09
- **상태:** 채택됨

## 무엇을 결정했나
사용자가 회의 제목을 수정하면 `status.json.titleOverride`에 저장한다. `deriveStatus`는 override가 있으면 그것을 제목으로 쓰고 `summary.title` 승격을 건너뛴다(`summarized` 랭크 승격은 그대로 유지). 제목 수정은 파생 상태가 `summarized`인 회의에서만, 그리고 v1은 회의 목록에서만 허용한다.

## 왜
- **단일 writer 불변**: `summary.json`은 요약 워커 단독 소유라 app-api가 제목을 거기 쓸 수 없다. app-api 소유 파일(status.json)에 `titleOverride`를 두면 소유권을 지키면서 사용자 제목을 영속한다.
- **재승격 클로버 방지**: `deriveStatus`는 매 read마다 `summary.title`을 `status.title`로 승격한다. override가 없으면 사용자가 고친 제목이 다음 read에서 되돌아간다. override가 title 분기만 가로채므로(랭크 분기는 별개) 재요약 후에도 사용자 제목이 보존된다.
- **파생 상태 게이팅**: 수동 `/meeting-summarize`로 요약된 회의는 status.json이 `transcribed`로 뒤처질 수 있어, persisted가 아닌 **파생 상태**로 게이트해 오탐 409를 막는다.

## 버린 대안
- **status.title 직접 수정**: 다음 `deriveStatus`가 summary.title로 덮어써 무효.
- **summary.json의 title 수정**: 요약 워커 단일 writer 위반.

## 영향받는 곳
- `src/domain/meeting.ts`(`StatusJson.titleOverride`), `src/lib/status.ts`(`deriveStatus` 제목 분기), `src/app/api/meetings/[id]/title/route.ts`(신규), `src/app/api/meetings/[id]/export/route.ts`(md만 effectiveTitle 반영, json은 raw 계약 유지).
