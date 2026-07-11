# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Local workspace/folder library**: a 272px desktop rail and accessible mobile
  drawer now switch between workspace All, Unfiled, and direct folder pages.
  Users can create/rename workspaces and create/edit folders up to three levels
  with semantic colors. Meeting files keep stable paths; organization is stored
  in the central `library.json` registry.
- **Bounded, recoverable library navigation**: canonical scope URLs, cursor
  next/previous pages, source-safe detail back links, global summary-attention
  navigation, and a separate "organization pending" section keep meetings
  discoverable without building an unbounded client list.
- **Read-only degraded library views**: a last-good tree or bounded global
  fallback remains available when registry data is corrupt, from a newer app
  version, or temporarily unreadable. Retry and fixed data-folder reveal are
  available; mutations stay disabled while recording can retain the last-known
  destination as an explicit, read-only hint.
- **Scoped, interruption-safe recording**: recording is available from every
  ready/last-good library scope and snapshots canonical destination IDs at
  start. Lost finalize responses are recovered with a same-ID bodyless probe;
  the retained Blob is resent only after the server confirms no publication.
  Result cards separate artifact durability, actual/fallback placement,
  playback preparation, and transcription recovery.
- **Metadata-only meeting and folder moves**: meetings can move within or across
  workspaces while their artifact directory and immutable bytes stay fixed.
  Folder subtrees can move within one workspace with cycle, depth, sibling-name,
  revision, and stale-destination checks. Shared pickers preserve safe detail
  context and clear stale selections instead of silently falling back.
- **Preservation-first container deletion**: folder/workspace previews separate
  visible meetings, affected and hidden placements, children, and pending
  finalize intents. Folder deletion rehomes meetings and promotes children;
  workspace deletion moves all meetings to a chosen destination Unfiled and
  atomically updates the default. Meeting artifact files are never deleted.
- **Crash-safe corrupt-library recovery**: corrupt registry views can explicitly
  rebuild from a fingerprint-guarded dialog after preserving the original in a
  private local archive. Restart planning, atomic intent phases, required
  namespace durability, recorder Blob gating, and full client generation reset
  prevent unsupported states or late old-generation responses from overwriting
  organization data.

- **Meeting title editing**: rename a summarized meeting from the list (kebab
  menu → 이름 수정). The manual title is stored as `titleOverride` in
  `status.json`, so it survives re-summarize and every re-derive.
- **Meeting deletion**: permanently delete a meeting folder from the list (kebab
  menu → 삭제) with an inline confirm. Refused while a summarize is in progress.
- **Glossary management**: a **단어 관리** tab to edit domain terms and
  "misheard → correct" pairs (`{ terms, corrections }`), applied by the LLM
  correction step. A legacy string-array `glossary.json` is still read as `terms`.
- **Left navigation rail**: a persistent library rail (desktop) and accessible
  mobile drawer expose workspace switching, meetings/glossary/settings links, and
  whisper/AI health status rows, plus a skip-to-content link.
- **Manual single-meeting re-summarize**: a "다시 요약" button on a summarized
  meeting regenerates just that one (applies glossary changes to existing
  meetings). No auto/bulk re-summarize — the background worker never re-runs a
  summarized meeting.

### Changed

- **App-wide UI/UX hardening**: modal dialogs and the mobile drawer now use the
  browser's native top layer, so focus stays contained, background content is
  inert, Escape/backdrop only dismiss the topmost surface, and a busy mutation
  can't be dismissed out from under you. The meeting list, editors, forms,
  banners, and the detail toolbar reflow cleanly from 320px up without horizontal
  scrolling, and the meeting detail follows a fixed order (title → status/location
  → notices → actions → audio/participants → tabs). Glossary and Settings now
  distinguish "loading", "ready", and "failed to load" instead of showing an
  empty form on a failed read, and only offer save/replace once current values
  are known. Audio playback supports HTTP Range requests, so seeking and
  re-seeking a long recording streams just the requested bytes and cancels
  cleanly on reload/navigation.
- **Correction step** now normalizes numbers/dates/times/amounts to Arabic
  numerals (values unchanged) and applies glossary `corrections`.
- **Glossary format**: `glossary.json` is now a `{ terms, corrections }` object
  (was a flat string array); the array form is auto-migrated on read.

### Fixed

- **Re-summarize reliability** (ADR 0009):
  - **Timeout**: LLM correction/summary calls now use a fixed 10-minute timeout
    (`LLM_GENERATION_TIMEOUT_MS`) instead of the 120s subprocess default — a long
    meeting's correction step re-emits the whole transcript and was being SIGKILLed.
  - **Async**: "다시 요약" no longer blocks the request for minutes. The route
    validates synchronously, fires the summarize in the background, and returns
    `202`; the detail view polls for the new summary.
  - **Failure visibility**: a failed re-summarize keeps the prior summary and the
    `summarized` state (instead of demoting to `transcribed`) and surfaces a
    "재요약 실패" banner with retry; `deriveStatus` preserves the `retry_summary`
    error on promotion so the GET route no longer silently erases it.
- **Honest LLM health & status** (claude):
  - **No false "실패 — check login"**: the sidebar claude health check now does a
    lightweight `claude --version` detection (labelled "감지됨", like codex) instead
    of a 25s `claude -p` probe a cold start could trip — auth is confirmed on the
    first real summary. The catch-all that reported every error as "check login" is
    gone.
  - **Error reason surfaced**: `exec` now includes the process's stdout tail in the
    failure error when stderr is empty, so a summary failure shows claude's actual
    reason (e.g. "Not logged in · Please run /login") instead of a blank exit code.
  - **No false-green backlog**: the home banner splits "요약 자동 처리 중 N" from
    "확인 필요 M" (transcribed meetings whose auto-summary failed and the worker
    backed off), so an exhausted meeting is no longer shown as forever
    "auto-processing".
  - **Poller hygiene**: the shared health poller dedups in-flight fetches per
    endpoint so a slow check can't stack across poll ticks.
- **Isolated claude summarize invocation** (ADR 0010):
  - **No context pollution**: claude summary calls now run in an isolated temp
    cwd (`os.tmpdir()`) with MCP + slash commands off, so the project's
    workspace `CLAUDE.md`/MCP context no longer leaks into the corrected
    transcript (a past pollution bug). The prompt and summary schema are
    unchanged.
  - **$0 guard**: paid-billing env vars — credentials (`ANTHROPIC_API_KEY`,
    `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`) and backend redirects
    (`ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`/`VERTEX`) — are scrubbed from
    the child environment so a subscription-OAuth CLI is never silently metered to
    a paid API; `HOME`/`PATH` (OAuth keychain + binary lookup) are kept.

## [0.1.0] - 2026-07-08

Initial public release. AI NOTE is a local-first meeting recorder: everything
runs on `127.0.0.1`, with no accounts, no stored API keys, and no telemetry.

### Added

- **Record → transcribe → summarize** pipeline, fully local: capture audio in
  the browser, transcribe with a local Whisper service, then summarize.
- **Bring-your-own summarizer**: summaries are generated by your own local
  Claude CLI, Codex CLI, or an Ollama model — no API keys stored.
- **Background auto-summary worker**: transcription and summarization continue
  even if you close the tab, producing a corrected transcript (`transcript.md`)
  and a structured summary (`summary.json`).
- **Export**: copy, download, or reveal the meeting folder to take your summary
  anywhere.
- **Whisper backends**: `mlx-whisper` on Apple Silicon, with a
  `faster-whisper` CPU fallback on Linux / Windows / Intel Mac.
- **Configuration** via `.env.local` (Whisper model, decode language, service
  host/port, ffmpeg path) and a domain-term `glossary.json`.
- Korean UI (v0.1); internationalization is on the roadmap.

[Unreleased]: https://github.com/mimpp92-dotco/ai-note/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mimpp92-dotco/ai-note/releases/tag/v0.1.0
