# Phase 3 — Transcription recovery and focused polish

## 목표

전사 실패가 목록과 상세에서 성공 상태처럼 보이지 않게 하고, finalize 결과와 상세의 retry가 기존 durable transcribe API를 실제 호출하게 한다. 완료 회의는 별도 query가 없으면 사용자가 가장 먼저 필요한 요약을 연다.

## 읽어야 할 파일

- `AGENTS.md`
- `src/CLAUDE.md`
- `docs/ARCHITECTURE.md`
- `docs/UI_GUIDE.md`
- `docs/decisions/0012-local-ingress-and-fixed-id-service-boundary.md`
- `docs/decisions/0014-durable-transcription-dispatch.md`
- `docs/decisions/0016-atomic-finalize-directory-publication.md`
- `src/app/api/transcribe/route.ts`
- `src/app/meetings/*/page.tsx`
- `src/components/Recorder.tsx`
- `src/components/RecorderFinalizeResultView.tsx`
- `src/components/MeetingList.tsx`
- `src/components/MeetingRow.tsx`
- `src/components/MeetingDetailView.tsx`
- `src/components/RecorderSessionProvider.tsx`
- `src/domain/meeting.ts`
- `src/lib/meetingLabels.ts`
- `src/lib/recorderFinalizeResult.ts`
- `src/lib/transcribe.ts`
- 관련 recorder, meeting row, view, transcribe test 파일

## 요구사항

- `R5`
- `R6`
- `R7`

## 허용 범위

- `src/app/meetings/*/page.tsx`
- `src/components/Recorder.tsx`
- `src/components/RecorderFinalizeResultView.tsx`
- `src/components/MeetingRow.tsx`
- `src/components/MeetingDetailView.tsx`
- `src/components/__tests__/RecorderFinalizeResultView.test.tsx`
- `src/components/__tests__/MeetingRow.test.tsx`
- `src/components/__tests__/RecorderSessionProvider.test.tsx`
- `src/components/__tests__/views.test.tsx`

## 금지 및 중단 조건

- `src/app/api/transcribe/route.ts`와 `src/lib/transcribe.ts`는 기존 API/dispatch 정본으로 읽기만 한다.
- 새 endpoint, dispatch ID, writer 또는 status schema를 만들지 않는다.
- local guard, tombstone fence, meeting operation lease, durable dispatch와 raw-last publication을 약화하지 않는다.
- audio, raw, segments, transcript 또는 summary artifact를 component가 직접 쓰지 않는다.
- path, dispatch ID, raw provider/fs output을 public error에 노출하지 않는다.
- workspace, library, summarize publisher, editor 또는 navigation guard를 함께 refactor하지 않는다.
- 허용 경로 밖 수정이 필요하면 중단한다.

## 작업

1. 현재 bug를 RED test로 재현한다.
   - finalize `전사 다시 시도` click이 refresh만 호출하고 `/api/transcribe`를 호출하지 않는 상태
   - `retry_transcription` row가 `전사 실패`가 아닌 일반 status label을 보이는 상태
   - detail status card에 retry action이 없는 상태
2. `Recorder`가 session의 exact `meetingId`를 finalize result view에 넘기고, view는 JSON `{id}`로 existing `/api/transcribe`를 호출한다.
3. finalize retry는 요청 중 disable/label, safe inline status와 aria-live를 제공한다. 성공 또는 in-progress race 뒤 finalize probe를 호출해 latest server result를 확인하고 trigger focus를 복원한다.
4. `MeetingRow`는 content generation 상태 다음, generic lifecycle label 전에 `retry_transcription`을 `전사 실패` badge로 표시한다.
5. `MeetingDetailView`의 StatusCard에 전사 실패 message와 실제 retry action을 추가한다. successful acceptance 뒤 `transcribing`이면 single-inflight 3초 refresh를 수행하고 navigation, unmount 또는 상태 변경에서 정리한다. client polling deadline을 새로운 전사 실패로 표시하지 않는다.
6. network/non-success는 static actionable copy를 보여 주고 retry control과 current artifact를 유지한다.
7. detail page의 `contentTab=script|summary`는 명시값이 우선한다. query가 없고 usable summary가 있으면 summary, 그렇지 않으면 script를 초기 tab으로 선택한다.
8. 기존 summary/transcript generation retry, edit draft, navigation guard와 status polling이 regression 없이 유지되는지 확인한다.

## 테스트 (먼저 작성)

- `RecorderFinalizeResultView.test.tsx`는 exact POST URL/body/header, duplicate click 방지, success refresh/focus와 safe failure retry를 검증한다.
- `MeetingRow.test.tsx`와 views test는 persistent `전사 실패` badge와 상세 CTA를 검증한다.
- detail test는 success/in-progress/failure, aria-live, refresh 종료와 explicit/default tab 우선순위를 검증한다.
- `RecorderSessionProvider.test.tsx`는 exact meetingId가 saved finalize result에서 retry surface까지 보존되는지 확인한다.
- 실제 Whisper, filesystem artifact와 user data를 사용하지 않는다.

## 문서 최신화

전사 failure/retry와 default summary tab은 Phase 5에서 ARCHITECTURE, UI_GUIDE, PRD와 ADR 0023에 반영한다.

## 완료 게이트

```bash
npm test -- src/components/__tests__/RecorderFinalizeResultView.test.tsx src/components/__tests__/MeetingRow.test.tsx src/components/__tests__/RecorderSessionProvider.test.tsx src/components/__tests__/views.test.tsx
npm run typecheck
```
