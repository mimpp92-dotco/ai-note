# AI NOTE

**Local-first meeting notes.** Record on your laptop, transcribe locally with Whisper, and optionally turn the transcript into a clean meeting summary with your own Claude CLI, Codex CLI, or loopback Ollama model. AI NOTE stores recordings and derived files on your machine, exposes its web/STT services only on `127.0.0.1`, has no hosted account, and never stores API keys.

Review the transcript or summary, search meetings without AI, and copy or export the result. The meeting-assistant chatbot is currently dormant; it is not part of the active pipeline.

> UI strings are currently Korean (v0.1). Internationalization is planned — see [Roadmap](#roadmap).

## Screenshots

| Home | Structured summary | Model settings | Mobile library |
|:---:|:---:|:---:|:---:|
| ![Home — workspace folder and meeting list](docs/media/home.png) | ![Meeting detail with structured summary and export toolbar](docs/media/detail.png) | ![Keyless model settings](docs/media/settings.png) | ![Mobile library drawer with workspace switcher and folders](docs/media/mobile.png) |

## Why it's private

- **Local app and storage.** Audio, transcripts, summaries, your optional profile, and derived search data stay under the local `data/` directory. The web server and transcription service bind to `127.0.0.1` only (never your LAN).
- **Your model choice controls inference.** Ollama keeps model inference on the configured loopback service. Claude/Codex CLI runs as a local process but may send the bounded transcript and summary prompt to the provider you signed in to; that processing follows the CLI provider's terms. AI NOTE adds no hosted backend of its own.
- **No API keys.** Summaries run through a CLI you're already signed in to (Claude/Codex) or a local model (Ollama). AI NOTE never stores an API key.
- **No AI NOTE telemetry.** There is no analytics or hosted sync surface. Recordings and generated artifacts live under `data/` (gitignored); model-provider traffic, if any, is determined only by the summarizer you select above.

## How it works

```
record (browser mic) → local Whisper (STT) → optional configured summary (worker) → view / search / export
```

1. Click **회의 녹음 시작 (Start meeting recording)** — audio is captured in the browser and saved locally.
2. On stop, a local **Whisper** service creates the initial automatic transcript.
3. If a summary model is configured, a background worker corrects that initial transcript and creates the structured summary — automatically, even if you close the tab.
4. Organize meetings in local workspaces and up to three folder levels, then
   review and **copy / download / reveal the folder**.
5. Use **검색 (Search)** to find a meeting without AI. (Asking across meetings — the **질문/회의 도우미 (Questions/Meeting assistant)** chatbot — is currently on hold; see below.)

## Edit a finished meeting

After the first corrected script and summary are created, each can be edited or regenerated independently from the meeting detail:

- Each selected tab starts with its own actions: script **copy / edit / rebuild from the original**, or summary **copy / JSON download / edit / rebuild from the current script**. Editing replaces the saved reading surface with one multiline textarea instead of adding a second surface below it.
- **전체 스크립트 수정** saves the corrected script as plain text. **회의록 요약 수정** opens the whole readable summary as one freeform plain-text body; generated sections and bullets become ordinary editable text, so headings can be removed and internal line breaks are preserved exactly.
- **원문에서 스크립트 다시 만들기** rebuilds only the full script from the initial automatic transcript. It keeps the existing summary and marks it **요약 갱신 필요** if the script changed.
- **현재 스크립트로 요약 다시 만들기** rebuilds only the summary from the currently saved full script; it never replaces that script.
- Saving or rebuilding the summary makes it current again. The meeting title and participant list keep their existing dedicated controls and are not changed by the summary editor.

There is no autosave: save or cancel an open edit before leaving. Copy and download actions continue to use the last confirmed saved content while an editor is open, and the action status says so. AI NOTE also guards links, browser back, and other app navigation so an unsaved draft or unresolved save is not discarded silently.

## Find meetings (meeting assistant dormant)

> **Note — the 질문 (Questions) chatbot is currently dormant.** The **회의 도우미 (Meeting assistant)** surface is held behind a build-time flag (`MEETING_ASSISTANT_ENABLED`, default off) and is not mounted in the app while its local-CLI agent loop is reworked. Its code, the `/api/chat` route, and the shared knowledge index are preserved, not removed. Plain **검색 (Search)** below keeps working. See [decisions/0019](docs/decisions/0019-meeting-assistant-dormant.md).

Open **검색 (Search)** from the library navigation. The active search surface performs deterministic, AI-free text matching over derived local search data, supports date/workspace/folder/status/action-item filters, and links each match back to the current live meeting. It does not scan every full transcript on every request.

The **질문 (Questions)** surface — currently dormant (see the note above) — reuses your configured summarizer through a bounded set of meeting-search and meeting-read tools. AI NOTE publishes a factual claim only when its cited meeting was actually read and is still live, assigns stable `[n]` numbers on the server, and lists the referenced meetings below the answer. This validates source provenance rather than automatically proving the model's interpretation, so important conclusions should still be checked against the linked meeting.

If the dormant assistant is re-enabled, conversation context is limited to four complete turns in the current browser tab and is never written to a chat-history file; refresh clears it. The optional **내 정보 (My information)** section in Settings can add a display name, aliases, timezone, and week-start preference, but leaving it unset does not block active ordinary search. If search data is incomplete, the search surface keeps the current query/results visible and offers a synchronous **검색 데이터 업데이트 (Update search data)** action.

The library rail supports workspace switching, All / Unfiled / direct-folder
views, workspace and folder creation/renaming, and semantic folder colors.
Meeting files stay at their stable `data/meetings/{id}/` paths; organization is
metadata only. If the registry cannot be read, the app keeps meetings visible in
a read-only last-good or global fallback view instead of silently rewriting it.
Only a corrupt registry offers explicit rebuild: the app requires the latest
fingerprint, preserves the original in a private local archive, creates a new
library generation, and places discovered live meetings in the new default
workspace's Unfiled view. Newer-format, I/O, unsupported-durability, and
ambiguous recovery states remain read-only and are never overwritten. Recovery
archives may contain local metadata and are retained under `data/` until you
remove them locally; their paths and contents are never returned to the browser.

Recording is available from every library scope. The destination is captured
when recording starts; interrupted saves keep the same meeting ID and audio in
memory, probe the local server before retrying, and report the actual/fallback
location separately from playback and transcription status.

Meetings can move to any workspace, folder, or Unfiled location without moving
their artifact directory. Folder subtrees can be reparented within their current
workspace; cross-workspace folder moves are intentionally not supported.

Deleting a folder or workspace is an organization-only operation: a preview
shows every affected meeting, hidden placement, child folder, and pending save
intent. Meetings and their recordings/transcripts/summaries are rehomed and
preserved; only the selected container metadata is removed.

## Requirements

| | |
|---|---|
| **Node.js** | ≥ 20 |
| **Python** | 3.11 or 3.12, via [`uv`](https://docs.astral.sh/uv/) (for the Whisper service) |
| **ffmpeg** | on your `PATH` (or set `FFMPEG_PATH`) |
| **A summarizer (optional)** | needed only for correction/summary: **Claude CLI**, **Codex CLI**, or **[Ollama](https://ollama.com)** running locally. Recording and local transcription work without one. |

### Platform support

| Platform | Transcription |
|---|---|
| **Apple Silicon (M-series)** | fast — uses `mlx-whisper` |
| **Linux / Windows / Intel Mac** | works — CPU fallback via `faster-whisper` (slower, no GPU path) |

The first transcription may take longer while the selected Whisper model is downloaded. The UI does not invent progress before that download finishes. The default (`large-v3`) is multi-GB; set `LOCAL_STT_MODEL=base` (or `small`) before launch for a faster first use.

## Quick start

```bash
node scripts/bootstrap.mjs --launch
```

Run this from a fresh clone with Node.js ≥ 20. It checks `uv` and `ffmpeg`, then runs `HUSKY=0 npm ci`, builds, starts an owned background app and Whisper service on free bounded loopback ports, waits for both health checks, and opens the exact `AI_NOTE_URL=http://localhost:<actual-port>` it prints. It never attaches to or stops an existing process on ports 3000/8123, and it does not create or overwrite `.env.local`.

If the doctor reports a missing prerequisite, follow its visible OS-specific instruction and rerun the same command. Bootstrap does not silently use `sudo`, install OS packages, log in to a provider, pull an Ollama model, or download a Whisper model. A summarizer is optional for recording and local transcription; choose and verify one later in **Settings → 요약 모델**.

```bash
npm run app:status  # ownership-checked status and actual URL
npm run app:stop    # stop only this repository's owned supervisor
npm run app:start   # restart the already installed build
```

If the desktop opener is unavailable or the environment is headless, the servers remain running and bootstrap prints the exact URL to open manually or with an agent browser surface.

### Installing with an AI agent

Give the agent the repository URL and this target contract:

- If you do not name a target, it must not install over the current directory. Inside another Git repository it chooses an `ai-note` sibling of that repository root; elsewhere it chooses a new `ai-note` child.
- If that default exists, it must not reuse, overwrite, or pull it. It chooses the first free deterministic suffix (`ai-note-2`, `ai-note-3`, …). If you explicitly name a non-empty target or one with another origin, it stops and reports the exact absolute path.
- Clone and installation may modify only the chosen target. They must not change an ancestor `.git`, `.claude`, `.harness`, global Git configuration, another `package.json`, or a running project.
- A path collision needs no approval; a safe suffix resolves it. The agent asks before a new privileged OS-package action or provider login.
- After reading this public contract, it runs the canonical bootstrap command and reports the absolute install path, branch or revision, and printed app URL. This repository cannot guarantee host-agent behavior that happened before its public contract was read.

The same contract is in [AGENTS.md](AGENTS.md); Claude Code can use `/setup`.

Contributor setup, foreground `npm run dev`, quality gates, and isolated browser regression live in [CONTRIBUTING.md](CONTRIBUTING.md). Playwright and Chrome/MCP are not product runtime dependencies.

## Configuration

Copy `.env.example` to `.env.local` and adjust as needed. Common knobs:

| Env | Default | Purpose |
|---|---|---|
| `LOCAL_STT_MODEL` | `large-v3` | Whisper model (`base`/`small` for speed) |
| `LOCAL_STT_LANG` | `ko` | Whisper decode language (`auto` to detect) |
| `LOCAL_STT_VAD` | `1` | Silence/hallucination filter (VAD); `0` to disable |
| `LOCAL_STT_HOST` / `LOCAL_STT_PORT` | `127.0.0.1` / `8123` | Whisper service address; bootstrap overrides the port only in its child environment when it selects another bounded candidate |
| `FFMPEG_PATH` | (from `PATH`) | Explicit ffmpeg binary |

Manage domain terms and "misheard → correct" pairs in the app's **단어 관리 (Glossary)** tab. They are applied by the LLM **correction** step (not the Whisper transcriber) to fix names and numbers. Stored in `glossary.json` as `{ terms, corrections }` (see `glossary.example.json`; a legacy string array is still read as `terms`).

## Project layout

| Path | Role |
|------|------|
| `src/` | Next.js app — recorder UI, API routes, domain contracts |
| `whisper/` | Local STT service (Python, `127.0.0.1`) |
| `docs/` | PRD · ARCHITECTURE · UI_GUIDE + decision records |
| `scripts/` | dev tooling (setup/link checks + isolated Playwright harness) |
| `e2e/` | synthetic Chromium scenarios and command-owned evidence reporter |

Module boundaries & data flow → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Working with an AI agent? Start at [AGENTS.md](AGENTS.md).

## Roadmap

- Internationalized UI (English + others)
- Packaged desktop distribution
- More summarizer backends

## License

[MIT](LICENSE) © 2026 Dylan

## Acknowledgements

AI NOTE stands on excellent open-source work:

- [OpenAI Whisper](https://github.com/openai/whisper) — the speech-recognition
  model behind local transcription.
- [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper) —
  fast Whisper inference on Apple Silicon.
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — the CPU fallback
  for Linux / Windows / Intel Mac.
- [ffmpeg](https://ffmpeg.org) — audio decoding and conversion.
- [Next.js](https://nextjs.org) — the app framework.
