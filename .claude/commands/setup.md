AI NOTE의 안전한 target을 정하고 canonical bootstrap으로 설치·기동한다. 인자 없음.

## 이 커맨드의 역할 (읽고 반드시 지킬 것)
- 설치 절차의 **정본은 `AGENTS.md`의 `## 설치` 섹션**이다. 이 커맨드는 그 절차를 실행하는 얇은 래퍼일 뿐 — 설치 단계를 여기 중복 기술하지 않는다.
- 이 공개 계약은 저장소 문서를 읽은 뒤부터 적용된다. Pre-clone agent host 정책까지 저장소가 보장한다고 말하지 않는다.
- 바이너리 설치(`brew`/`apt`/`uv`)와 provider 로그인은 새 권한이 필요할 때만 사용자에게 명령과 이유를 보여 주고 승인을 받는다.
- `data/settings.json`을 직접 쓰지 않는다(app-api 단일 writer). 요약기 provider 선택은 앱 Settings 화면으로 유도한다.
- `npm run dev`는 contributor용 foreground command이며 설치 성공 경로로 사용하지 않는다.

## 절차
1. 이미 이 저장소 root에서 실행 중이면 그 exact root를 선택된 target으로 사용한다. 저장소 URL만 받은 상태라면 `AGENTS.md` 규칙대로 absolute target을 먼저 보고한다: 다른 Git repo 안은 그 root의 sibling `ai-note`, 그 밖은 cwd 아래 새 `ai-note`; 충돌 시 첫 free `ai-note-N`. 명시 target이 non-empty/다른 origin이면 exact path와 함께 중단한다.
2. Clone·설치는 target 안에서만 수행하고 ancestor/global config/다른 project/process를 건드리지 않는다.
3. Target root에서 `node scripts/bootstrap.mjs --launch`를 실행한다. 이 command가 install/build mutation 전에 runtime ownership을 판정하게 둔다. Absent만 doctor/install/build/start를 수행한다. Owned면 자동 stop/restart/install/build하지 않고 기존 runtime을 검증하며 update 미적용 안내를 전달한다. Stale/unsafe/unverifiable이면 signal이나 mutation 없이 중단한다.
4. Doctor가 Node/`uv`/`ffmpeg`에서 멈추면 출력된 안전한 OS별 조치를 보여 주고 필요한 권한을 받은 뒤 같은 command를 재실행한다. Windows에서 전제 도구나 독립 Codex CLI를 설치했다면 새 PowerShell을 열고, owned runtime에는 새 environment 적용 전 진행 중 녹음이 없는지 확인해 `npm run app:stop` 후 같은 `--launch`를 다시 실행한다. Codex warning/health failure는 녹음·전사의 blocker가 아니며 binary health를 인증·실제 요약 성공으로 표현하지 않는다.
5. Bootstrap이 app health, Whisper health, AI NOTE root HTML, existing `/api/library` public mode의 네 bounded probe를 마치도록 기다린다. Library `ready|degraded_last_good|degraded_fallback`은 지원하되 corrupt/unsupported/I/O를 bootstrap이 복구·덮어쓰거나 data를 직접 쓰게 하지 않는다. Fixed 3000을 가정하지 않고 네 probe 뒤 출력된 `AI_NOTE_URL=http://localhost:<actual-port>`를 사용한다.
6. Desktop opener가 실패하거나 headless면 server 성공을 유지하고 exact URL을 사용 가능한 agent browser surface로 연다.
7. 최종 handoff에 absolute install path, branch/revision, 실제 앱 URL을 보고한다. 요약기는 앱 Settings에서 선택·저장·자동 health 확인하도록 안내한다.
