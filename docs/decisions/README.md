# 결정 기록 (ADR / decisions)

이 폴더는 **코드만 봐선 왜 이렇게 했는지 모를** 결정을 기록한다. 비자명한 결정이 생길 때마다 `NNNN-제목.md` 하나 — `docs/decisions/0000-template.md`를 복사해 5칸만 채운다.

> 목적: 3개월 뒤(또는 새 에이전트가) "이거 왜 이렇게 했지?"를 코드 추측이 아니라 여기서 답한다.
> **주의(Note):** 결정 기록은 참조 문서다. 계약은 `docs/ARCHITECTURE.md`와 루트 `AGENTS.md`에.

## 새 ADR 추가

```bash
cp docs/decisions/0000-template.md docs/decisions/0024-내-결정.md
$EDITOR docs/decisions/0024-내-결정.md   # 5칸 채우고 아래 목록에 추가
```

## 목록

| # | 결정 | 상태 |
|---|------|------|
| [0001](0001-local-whisper-batch.md) | STT는 로컬 whisper 완전 배치 | 채택됨 |
| [0002](0002-claude-command-no-app-llm.md) | 교정·요약은 로컬 CLI/Ollama로 처리 (팀 모드에서 갱신) | 채택됨(갱신) |
| [0003](0003-local-files-single-writer.md) | 로컬 파일 저장 + 단일 writer 소유권 | 채택됨 |
| [0006](0006-lean-mvp-defer-v2.md) | 린 MVP-0 — 견고성 일부 v2 연기 | 채택됨 |
| [0007](0007-delete-meeting-record.md) | 회의 삭제 = 폴더 전체 영구 삭제(rename-then-rm) | 대체됨(→0015) |
| [0008](0008-title-override.md) | 표시 제목은 `titleOverride`로 app-api 소유(override 우선) | 채택됨 |
| [0009](0009-async-resummarize-failure-visibility.md) | 재요약 비동기화(202) + 실패 가시성 + 생성 타임아웃 600초 | 채택됨 |
| [0010](0010-isolated-claude-summarize-invocation.md) | claude 요약 호출 격리(cwd·MCP-off·$0 env 스크럽) — ADR 0002 정제 | 채택됨 |
| [0011](0011-library-registry-and-durable-commits.md) | 중앙 library registry, stable meeting path, 4-state 내구 commit | 채택됨 |
| [0012](0012-local-ingress-and-fixed-id-service-boundary.md) | local-only request/DTO 경계와 fixed-ID Whisper protocol | 채택됨 |
| [0013](0013-durable-summarize-pair-publication.md) | Durable summarize attempt와 generation-consistent pair 발행 | 채택됨 |
| [0014](0014-durable-transcription-dispatch.md) | Durable transcription dispatch와 raw-last completion marker | 채택됨 |
| [0015](0015-durable-meeting-tombstone.md) | Durable meeting tombstone이 logical delete commit | 채택됨 |
| [0016](0016-atomic-finalize-directory-publication.md) | Finalize는 receipt를 포함한 directory rename으로 publish | 채택됨 |
| [0017](0017-corrupt-library-rebuild-and-generation-reset.md) | Corrupt library 원본 보존형 재구축과 client generation reset | 채택됨 |
| [0018](0018-meeting-knowledge-index-and-chatbot.md) | 파생 지식 인덱스와 근거 기반 회의 챗봇 | 채택됨 |
| [0019](0019-meeting-assistant-dormant.md) | 회의 도우미(챗봇) UI를 flag로 dormant, 코드·계약 보존(0018 유지) | 채택됨 |
| [0020](0020-deterministic-synthetic-browser-verification.md) | 반복 browser gate는 격리 synthetic Playwright, Chrome DevTools MCP는 선택적 정성 검토 | 채택됨 |
| [0021](0021-manual-transcript-and-summary-editing.md) | 불변 원본 위 editable transcript/summary와 독립 재생성·freshness·저장 probe | 채택됨 |
| [0022](0022-inline-freeform-meeting-content-editing.md) | Tab-local action과 본문 교체형 single-textarea 편집 — 0021의 footer·structured summary form만 부분 대체 | 채택됨 |
| [0023](0023-installation-and-first-run-ux.md) | 안전한 install target, owned background runtime과 provider-aware first-run UX | 채택됨 |
