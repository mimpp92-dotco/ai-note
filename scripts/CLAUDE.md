# scripts — 유틸리티 스크립트

상위 진입점: [../AGENTS.md](../AGENTS.md) · 전체 계약: [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)

## 목적 Purpose / Owns
저장소 유지보수용 Node 스크립트를 소유한다.

- `scripts/check-links.mjs` — 마크다운 링크 무결성 체커(CI 게이트). 저장소 내 모든 `.md`의 상대 링크가 실재 파일/디렉토리를 가리키는지 검사, 깨진 링크가 하나라도 있으면 exit 1.

## 자주 하는 변경 Common changes (patterns)
- **링크 검사 규칙 변경**: `scripts/check-links.mjs`의 `IGNORE_DIRS`/`LINK_RE`만 수정. 생성물·의존성 디렉토리(`node_modules`·`.next`·`data` 등)는 스캔에서 제외한다.

## 의존 Dependencies (cross-module)
- 순수 Node stdlib. 저장소 루트에서 실행.

```bash
npm run check:links    # 마크다운 죽은 링크 0 검사
```
