# 0012 — local ingress·public DTO·fixed-ID service 경계

- **날짜:** 2026-07-10
- **상태:** 채택됨

## 무엇을 결정했나

모든 app data surface는 side effect 전에 exact loopback Host, Fetch Metadata, unsafe-method Origin을 공통 검증한다. JSON은 content type과 raw byte cap을 적용하고, public meeting/error DTO는 internal path·job/dispatch·attempt·raw provider/fs output을 allowlist 밖으로 둔다.

App의 Ollama/Whisper egress는 explicit-port loopback HTTP만 허용하고 redirect를 거부한다. App→Whisper request는 client-supplied path 대신 `{meetingId,dispatchId}`만 사용한다. Whisper가 configured data root 아래 fixed path를 파생하고 service-owned audio-hash claim으로 same-pair dedupe/restart resume/publication phase를 소유한다.

## 왜

Loopback bind만으로는 malicious page가 사용자의 browser를 통해 local API를 호출하는 DNS rebinding/CSRF 계열 요청을 막지 못한다. 또한 absolute path protocol은 local service가 임의 파일 writer가 되는 위험이 있다. Request ingress와 service egress를 양쪽에서 좁혀야 local-first 경계가 실제 보안 불변식이 된다.

## 버린 대안

- Bind만 127.0.0.1로 제한 — browser-origin 요청과 Host confusion을 막지 못해 기각.
- CORS allowlist만 사용 — simple request는 CORS response 차단 전에 side effect가 날 수 있어 기각.
- `X-Forwarded-*` 신뢰 — local direct server에 불필요한 proxy ambiguity를 만들어 기각.
- Whisper에 absolute input/output path 전달 — path traversal/임의 writer surface라 기각.
- App memory job ID만 사용 — response loss/process restart에서 duplicate model work를 막지 못해 기각.

## 영향받는 곳

`src/lib/localRequestGuard.ts`, `src/lib/publicApi.ts`, `src/lib/localEndpoint.ts`, `src/app/api/**`, `src/app/meetings/[id]/page.tsx`, `src/services/whisperClient.ts`, `src/services/llm/ollama.ts`, `whisper/server.py`. Registry/file durability 의미는 ADR 0011, Claude isolation/$0 env는 ADR 0010을 따른다.

Phase 8의 app-side durable acceptance·canonical adoption CAS·raw completion marker는 ADR [0014](0014-durable-transcription-dispatch.md)가 이 fixed-ID 경계를 정제한다.
