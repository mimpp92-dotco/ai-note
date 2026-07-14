# 0019 — 회의 도우미(챗봇) dormant

- **날짜:** 2026-07-14
- **상태:** 채택됨

## 무엇을 결정했나

우측 `회의 도우미` 챗봇 UI를 삭제하지 않고 build-time flag `MEETING_ASSISTANT_ENABLED`(`src/lib/features.ts`, 기본 `false`)로 **UI 마운트만 차단**한다. `layout.tsx`는 이 flag가 `true`일 때만 `<ChatPanel />`을 렌더한다. 챗봇 코드·`POST /api/chat` 라우트·오케스트레이션 로직·테스트·공유 지식 인덱스는 그대로 보존한다. 되살리는 법: flag를 `true`로 바꾸는 한 줄 코드 변경(환경변수 아님 — dormant 상태가 review 가능하고 `next build`가 결정적으로 유지되도록 컴파일타임 상수로 둔다).

## 왜

챗봇은 로컬 CLI(claude/codex, $0 원칙) 위에서 도는 도구 호출형 agent 루프다. 실사용에서 두 한계가 드러났다: (1) 로컬 CLI 응답의 JSON envelope 파싱이 취약해(코드블록/머리말/wrapper 혼입) fail-closed 경로로 자주 빠지고, (2) discovery/citation 분리 설계상 근거 재확인 단계가 지연을 키워, 실제 corpus에서 "확인된 출처 없음"으로 답이 비는 경우가 잦았다. 접근을 재설계하는 동안 기능을 사용자에게 노출하지 않는 편이 낫다고 판단했다. 코드는 이미 검증·테스트되어 있어 삭제하면 재구축 비용이 크므로 dormant로 보존한다.

## 버린 대안

- **코드 삭제**: 재활성화 시 UI/라우트/오케스트레이터/테스트를 재구축해야 하고, 보존된 서버 계약(ADR 0018)과의 정합성도 다시 맞춰야 해 비용이 크다.
- **환경변수 flag**: 런타임 분기가 생겨 `next build`가 env에 의존하게 되고 dormant 상태가 diff에 드러나지 않는다. 컴파일타임 상수가 build-green·reviewable 원칙에 맞다.
- **`/api/chat` 라우트까지 비활성화**: 라우트는 UI가 마운트되지 않으면 호출되지 않으므로 굳이 손대지 않는다. 계약·테스트를 그대로 두는 편이 재활성화가 단순하다.

## 영향받는 곳

- `src/lib/features.ts`(flag 정본), `src/app/layout.tsx`(조건부 마운트), `src/app/__tests__/layout.test.tsx`(dormant 셸 + flag-on 재활성 단언).
- 보존(미변경): `src/components/ChatPanel.tsx`·`ChatClient.tsx`·`ChatAnswer.tsx`, `src/app/api/chat/route.ts`, `src/lib/chatOrchestrator.ts`·`chatTools.ts`·`transcriptSearch.ts`, `src/domain/chat.ts`, 공유 `src/lib/knowledgeIndex.ts`(검색도 사용 — 계속 live).
- **ADR [0018](0018-meeting-knowledge-index-and-chatbot.md)과의 관계**: 0018의 서버 계약(`/api/chat` tool protocol, evidence ledger, `search_transcripts` discovery, persistence/provider 경계)은 그대로 유효하다. 이 ADR은 그 결정을 뒤집지 않고 **UI 진입점만 gated**한다. 0018은 보존하며 수정하지 않는다.
- 검색(SearchOverlay / `useMeetingSearch` / `GET /api/search`)과 공유 지식 인덱스는 이 flag와 무관하게 dormant 중에도 계속 동작한다.
