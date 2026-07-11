AI NOTE 앱의 canonical 요약 pipeline을 시작한다. 인자: `{id|latest}`. 인자가 없으면 `latest`를 사용한다.

이 명령은 회의 파일을 읽거나 쓰지 않는다. 교정·요약·상태 갱신은 실행 중인 로컬 앱이 coordinator와 설정된 Claude/Codex CLI 또는 Ollama를 통해 수행한다.

저장소 루트에서 다음 trigger만 실행한다.

```bash
node scripts/meeting-summarize.mjs "$ARGUMENTS"
```

- 기본 앱 주소는 `http://127.0.0.1:3000`이다. 다른 로컬 port를 사용하면 `AI_NOTE_BASE_URL=http://127.0.0.1:<port>`를 명시한다.
- Trigger는 explicit loopback HTTP 주소만 허용하고 redirect/port scan을 하지 않는다.
- 앱이 꺼져 있거나 요청이 충돌하면 출력된 safe code에 따라 앱 상태·설정을 확인한다. Raw response나 로컬 경로를 출력하지 않는다.
- 성공하면 앱 UI에서 진행 상태와 결과를 확인한다. 별도 직접-writer fallback을 만들지 않는다.
