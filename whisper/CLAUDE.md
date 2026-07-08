# whisper — 로컬 STT 서비스 (Python)

상위 진입점: [../AGENTS.md](../AGENTS.md) · 전체 계약: [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)

## 목적 Purpose / Owns
오디오를 로컬에서 배치 전사하는 stdlib HTTP 서버를 소유한다. `raw.md`·`segments.json`의 **단일 writer** — 다른 모듈은 이 파일을 쓰지 않는다.

- `whisper/server.py` — `127.0.0.1:8123` 바인딩(`LOCAL_STT_HOST`/`LOCAL_STT_PORT`). health + transcribe.
- `whisper/pyproject.toml` — uv 프로젝트(3.11/3.12 핀). mlx-whisper large-v3, 폴백 faster-whisper.

## 자주 하는 변경 Common changes (patterns)
- **엔진/모델 교체**: `whisper/server.py`의 `_transcribe_real`만 수정. **주의**: mlx_whisper/faster_whisper는 **절대 top-level import 금지** — 지연 import로 FAKE 모드/health가 순수 stdlib로 뜨게 유지.
- **테스트/스모크**: `FAKE_WHISPER=1`이면 canned segments 반환(모델·네트워크·venv 불필요). CI·AC 스모크는 이 모드 사용.
- **Note(127.0.0.1)**: 로컬 인터페이스만 바인딩. LAN 노출 금지.

## 의존 Dependencies (cross-module)
- `src`(`src/services/whisperClient.ts`)가 HTTP로 호출하는 하류 서비스.
- ffmpeg가 PATH에 있으면 사용(`whisper/server.py`의 `ffmpeg_path`).
- 무거운 작업(모델 다운로드)은 **런타임에만**.

```bash
FAKE_WHISPER=1 uv run --project whisper python whisper/server.py  # 순수 stdlib 스모크
curl -s 127.0.0.1:8123/health
```
