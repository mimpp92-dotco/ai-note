# whisper — 로컬 STT 서비스 (Python)

상위 진입점: [../AGENTS.md](../AGENTS.md) · 전체 계약: [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)

## 목적 Purpose / Owns
오디오를 로컬에서 배치 전사하는 stdlib HTTP 서버를 소유한다. `raw.md`·`segments.json`의 **단일 writer** — 다른 모듈은 이 파일을 쓰지 않는다.

- `whisper/server.py` — `127.0.0.1:8123` 바인딩(`LOCAL_STT_HOST`/`LOCAL_STT_PORT`). health + fixed-ID transcribe + explicit model prepare. Client path를 받지 않고 `AI_NOTE_DATA_ROOT/meetings/{meetingId}` 아래만 파생한다.
- `whisper/model_catalog.py` — fixed logical catalog. `large-v3`(기본·품질 우선)→`mlx-community/whisper-large-v3-mlx`, `large-v3-turbo`→`mlx-community/whisper-large-v3-turbo`; faster-whisper도 같은 logical ID를 쓴다.
- `whisper/pyproject.toml` — uv 프로젝트(3.11/3.12 핀). mlx-whisper, 폴백 faster-whisper.

## 자주 하는 변경 Common changes (patterns)
- **엔진/모델 교체**: `whisper/server.py`의 `_transcribe_real`만 수정. **주의**: mlx_whisper/faster_whisper는 **절대 top-level import 금지** — 지연 import로 FAKE 모드/health가 순수 stdlib로 뜨게 유지. 임의 repo/path/model 입력을 추가하지 말고 fixed catalog 변경은 별도 결정과 실제 비교를 요구한다.
- **테스트/스모크**: `FAKE_WHISPER=1`이면 canned segments 반환(모델·네트워크·venv 불필요). CI·AC 스모크는 이 모드 사용.
- **Note(127.0.0.1)**: 로컬 인터페이스만 바인딩. LAN 노출 금지. App/bootstrap의 same-origin health authority가 `localhost`여도 direct App→Whisper URL과 child bind는 explicit-port `127.0.0.1`을 유지한다.
- **Ingress**: exact configured Host/port, JSON content type/byte cap, unknown-field reject. Browser Origin/Fetch Metadata는 거부하며 CORS를 열지 않는다. App server marker는 browser fetch와 server-to-server fetch를 구분할 뿐 권한 token이 아니다.
- **Pipeline settings/model snapshot**: 저장된 `data/pipeline-settings.json`이 있으면 catalog model이 정본이고 missing일 때만 `LOCAL_STT_MODEL`/`LOCAL_STT_MLX_REPO` legacy startup path를 쓴다. 새 claim v2는 acceptance 시 effective `{source,id,mlxRepo,fasterWhisperModel}` snapshot을 고정한다. 이후 설정 변경은 accepted/processing 또는 same-dispatch manual resume에 영향을 주지 않는다. Schema-v1 claim과 claim-less legacy raw는 계속 읽는다.
- **Model prepare fence**: 설정 저장은 download/load를 시작하지 않는다. `/models/prepare`만 explicit async prepare를 시작하며 prepare와 inference는 같은 process-global execution fence를 공유한다. 동시에 model swap/download/inference를 실행하지 않는다.
- **Dispatch claim**: meeting별 `.whisper-dispatch.json`은 Whisper만 쓴다. `(meetingId,dispatchId)`가 protocol identity이며 v2는 model snapshot과 audio hash, `accepted|segments_published|raw_published`, `pending|durable|best_effort`를 기록한다. Same audio의 fresh proposal은 canonical ID adoption을 반환하고 audio mismatch는 fail-closed한다.
- **Completion marker**: segments를 먼저 발행·claim advance한 뒤 raw를 마지막에 publish한다. Raw rename 뒤 claim이 matching `raw_published` + non-pending일 때만 done을 보고한다. Pending claim은 parent sync와 같은 dispatch만 resume하며 fresh model work/output을 만들지 않는다.
- **내구성**: claim/output은 file fsync→publish→meeting parent sync. Known directory-sync 미지원은 best-effort로 진행하고 transient pending이면 model/다음 publication을 시작하지 않은 채 같은 claim namespace sync만 재시도한다.

## 의존 Dependencies (cross-module)
- `src`(`src/services/whisperClient.ts`)가 `{meetingId,dispatchId}` HTTP protocol로 호출하는 하류 서비스.
- ffmpeg가 PATH에 있으면 사용(`whisper/server.py`의 `ffmpeg_path`).
- 무거운 작업(모델 다운로드)은 **런타임에만**.

```bash
FAKE_WHISPER=1 uv run --project whisper python whisper/server.py  # 순수 stdlib 스모크
curl -s 127.0.0.1:8123/health
```
