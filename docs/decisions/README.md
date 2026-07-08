# 결정 기록 (ADR / decisions)

이 폴더는 **코드만 봐선 왜 이렇게 했는지 모를** 결정을 기록한다. 비자명한 결정이 생길 때마다 `NNNN-제목.md` 하나 — `docs/decisions/0000-template.md`를 복사해 5칸만 채운다.

> 목적: 3개월 뒤(또는 새 에이전트가) "이거 왜 이렇게 했지?"를 코드 추측이 아니라 여기서 답한다.
> **주의(Note):** 결정 기록은 참조 문서다. 계약은 `docs/ARCHITECTURE.md`와 루트 `AGENTS.md`에.

## 새 ADR 추가

```bash
cp docs/decisions/0000-template.md docs/decisions/0008-내-결정.md
$EDITOR docs/decisions/0008-내-결정.md   # 5칸 채우고 아래 목록에 추가
```

## 목록

| # | 결정 | 상태 |
|---|------|------|
| [0001](0001-local-whisper-batch.md) | STT는 로컬 whisper 완전 배치 | 채택됨 |
| [0002](0002-claude-command-no-app-llm.md) | 교정·요약은 로컬 CLI/Ollama로 처리 (팀 모드에서 갱신) | 채택됨(갱신) |
| [0003](0003-local-files-single-writer.md) | 로컬 파일 저장 + 단일 writer 소유권 | 채택됨 |
| [0006](0006-lean-mvp-defer-v2.md) | 린 MVP-0 — 견고성 일부 v2 연기 | 채택됨 |
