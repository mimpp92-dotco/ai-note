# Phase 5 — Runtime 진단 회귀와 정본 문서

## 읽어야 할 파일

Fresh session은 bootstrap ownership/health 코드와 test, Phase 1~4 최종 구현, 모든 관련 root/module 문서와 ADR 0001·0009·0010·0012·0013·0014·0020·0023을 읽는다. 과거 ADR은 당시 결정을 보존하는 기록이고 현재 계약은 root instructions와 architecture임을 전제로 한다.

## 요구사항

- R1~R6: 구현된 manual retry, model, checkpoint, adapter, fast mode, benchmark 계약을 문서 정본에 정확히 반영한다.
- R7: `app:status`/bootstrap Host 오진을 회귀 test로 고치고 ADR 0024를 추가한다.

## 허용 범위

Bootstrap health URL과 regression test, 공개·기여 문서, root/module instructions, PRD/architecture/UI guide, ADR index와 새 ADR만 변경한다. Phase 1~4 제품 코드는 이 phase에서 기회주의적으로 고치지 않는다.

## 금지 및 중단 조건

- App/Whisper bind를 loopback 밖으로 넓히거나 ownership 불명 PID를 종료하지 않는다.
- Actual benchmark 결과 없이 Turbo/fast를 권장 또는 default라고 쓰지 않는다.
- Historical ADR을 지우거나 새 ADR이 tombstone/publisher/fixed-ID 원칙을 약화하지 않는다.
- Auto resume/retry, stage progress, supervisor restart/autostart, summary map-reduce를 구현됐다고 쓰지 않는다.
- 문서와 implementation/test가 다르면 문서를 꾸미지 말고 해당 owner phase repair가 필요하다고 중단한다.

## 작업

1. Bootstrap regression을 먼저 작성한다.
   - App 자체와 `/api/whisper/health` probe URL 모두 `canonicalAppUrl()`의 `localhost` authority를 사용한다.
   - Child bind와 direct App→Whisper egress는 계속 `127.0.0.1`이다.
   - `app:status`는 owned live runtime에서 connected/ready Whisper를 ready로 보고하고 403을 ready failure로 오인하지 않는다.
   - Dynamic port, headless opener fallback, token/PID ownership과 no-signal contract는 그대로다.
2. README/CONTRIBUTING/CHANGELOG를 갱신한다.
   - 두 quality Whisper option, save vs prepare, first lazy download, model snapshot/manual retry를 설명한다.
   - `LOCAL_STT_MODEL=base/small`은 stored pipeline settings가 없을 때의 legacy startup path로 설명하고 새 UI 추천으로 홍보하지 않는다.
   - Explicit benchmark command가 실제 회의와 configured provider를 사용하며 local runtime output만 만든다는 경고를 붙인다.
3. AGENTS와 module instructions를 갱신한다.
   - `data/pipeline-settings.json`, correction checkpoint와 writer/reader ownership을 추가한다.
   - Claim v2 model snapshot, global Whisper fence와 same-dispatch model invariant를 추가한다.
   - Automated test/browser에서는 benchmark/actual model/data가 금지됨을 유지한다.
4. PRD/ARCHITECTURE/UI_GUIDE를 현재 동작에 맞춘다.
   - Full default, fast experimental, manual-only retry, checkpoint resume와 timeout 30분을 정본화한다.
   - 실제로 자르지 않던 40,000자 경고를 제거하고 summary map-reduce는 계속 deferred로 둔다.
   - Settings section의 DOM/접근성·save/prepare 상태 문구와 browser scenarios를 기록한다.
5. ADR 0024를 작성하고 index를 갱신한다.
   - Quality-first default와 evidence-based recommendation gate.
   - Pipeline settings/prepare와 claim model snapshot.
   - Correction checkpoint/manual retry/chunk concurrency.
   - CLI capability/schema isolation과 30분 timeout.
   - Explicit real-data benchmark vs synthetic automated QA.
   - ADR 0001의 fixed-only large-v3, ADR 0009/0010의 600초·old CLI invocation 부분만 supersede하고 다른 결정은 보존한다.

## 테스트 (먼저 작성)

- `runLaunchFlow`와 `runStatus`가 localhost app authority를 쓰는 RED regression.
- Direct service URL은 여전히 explicit-port `127.0.0.1`.
- Ownership invalid/stale/no heartbeat에서 기존 no-signal behavior.
- Link checker가 새 ADR·문서 링크를 모두 확인한다.

## 문서 최신화

이 phase 자체가 문서 owner다. 제품 코드에 없는 추천·복구·progress를 서술하지 않으며 실제 benchmark 후 필요한 추천 변경은 별도 사용자 승인으로 남긴다.

## 완료 게이트

저장소 루트에서 실행한다.

```bash
npm test -- scripts/__tests__/bootstrap.test.mjs
npm run check:links
```
