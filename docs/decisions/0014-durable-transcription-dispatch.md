# 0014 — Durable transcription dispatch와 raw-last completion marker

- **날짜:** 2026-07-10
- **상태:** 채택됨

## 무엇을 결정했나

App은 Whisper HTTP 호출 전 `status.transcriptionDispatch` reserved ID를 durable/best-effort commit한다. 응답 유실·retry·app restart는 같은 ID를 재전송한다. Service가 same audio의 기존 canonical ID를 증명하면 app은 expected proposed ID를 CAS한 뒤에만 canonical ID를 보낸다.

Whisper는 service-owned claim에 audio hash·dispatch·publication phase·durability를 기록한다. `segments.json`을 먼저 publish하고 `raw.md`를 마지막 completion marker로 publish한다. App consumer는 matching `raw_published` claim, non-pending durability, audio identity, valid segments를 확인해야만 전사를 노출·요약한다. Claim-less legacy raw는 호환한다.

## 왜

In-memory job ID는 재시작에서 사라지고, response loss 후 fresh ID는 duplicate model work와 immutable output 충돌을 만든다. 또 segments를 먼저 쓰는 도중 crash에서 파일 존재만 보면 partial transcript를 완료로 오판한다. 양쪽 durable identity와 raw-last marker를 결합해 duplicate·partial visibility를 막는다.

## 버린 대안

- Process-global proposed-ID Map: app restart 후 유실된다.
- Service adoption을 client 내부에서 즉시 재시도: app status가 canonical ID를 모른 채 다시 crash할 수 있다.
- `raw.md` 존재만 completion으로 사용: claim/audio/segments 모순을 숨긴다.
- Pending namespace sync에서 fresh dispatch: 이미 commit된 marker/job을 duplicate로 만들 수 있다.

## 영향받는 곳

`src/lib/transcribe.ts`, `src/lib/transcriptionArtifacts.ts`, status schema/updater, status/detail/summary worker consumers, `src/services/whisperClient.ts`, `whisper/server.py`. Fixed-ID ingress 경계는 ADR [0012](0012-local-ingress-and-fixed-id-service-boundary.md), operation/status lock은 ADR 0013을 따른다.
