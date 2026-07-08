AI NOTE 설치를 점검하고 막힌 전제 도구(`uv`·`ffmpeg`·요약기)를 설치·안내한다. 인자 없음.

## 이 커맨드의 역할 (읽고 반드시 지킬 것)
- 설치 절차의 **정본은 `AGENTS.md`의 `## 설치` 섹션**이다. 이 커맨드는 그 절차를 실행하는 얇은 래퍼일 뿐 — 설치 단계를 여기 중복 기술하지 않는다.
- 바이너리 설치(`brew`/`apt`/`uv`)는 시스템 변경이므로 **사용자에게 명령을 보여주고 실행**한다(sudo·확인 필요할 수 있음).
- `data/settings.json`을 직접 쓰지 않는다(app-api 단일 writer). 요약기 provider 선택은 앱 Settings 화면으로 유도한다.
- 검증 때 `npm run dev`를 **포그라운드로 붙잡지 않는다**(long-lived + 첫 모델 다운로드).

## 절차
1. `node scripts/setup.mjs`를 실행해 진단을 얻는다(무의존이라 `npm install` 전에도 됨).
2. `AGENTS.md`의 `## 설치` 절차(0~5단계)대로 각 ✗ 항목을 해결한다: Node 확보 → `ffmpeg`/`uv` OS별 설치 → `npm install` → 요약기 준비.
3. `node scripts/setup.mjs`를 다시 실행해 필수 전제(Node/uv/ffmpeg)가 전부 ✓, exit 0 인지 확인한다.
4. `npm run build`로 build-green을 확인한다. 실제 구동 확인이 필요하면 `LOCAL_STT_MODEL=base npm run dev`를 백그라운드로 띄우고 `GET /api/whisper/health`를 확인한다.
5. 요약기 provider는 앱 기동 후 Settings 화면에서 선택·검증하도록 사용자에게 안내한다.
