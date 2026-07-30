# Contributing to AI NOTE

Thanks for your interest in improving AI NOTE! It's a local-first meeting
recorder — record → transcribe locally with Whisper → summarize with your own
Claude/Codex CLI or a local Ollama model. Contributions of all sizes are
welcome.

By participating, you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

The README quick start is the end-user owned-background path. Contributors use
the foreground development path below. You'll need:

- **Node.js ≥ 20**
- **Python 3.11 or 3.12** via [`uv`](https://docs.astral.sh/uv/) (for the local
  Whisper service)
- **ffmpeg** on your `PATH` (or set `FFMPEG_PATH`)
- **one summarizer for summary work**: the Claude CLI, the Codex CLI, or a local
  [Ollama](https://ollama.com). Recording/transcription development does not
  require one.

Then:

```bash
node scripts/setup.mjs  # read-only prerequisite doctor
npm ci                 # exact dependencies (+ contributor hooks)
npm run dev            # foreground Next.js + local Whisper service
```

The first real transcription lazily downloads the selected Whisper model.
The app's fixed pipeline settings default to quality-first `large-v3`; saving
`large-v3` or `large-v3-turbo` is separate from the explicit model-prepare
action. `LOCAL_STT_MODEL`/`LOCAL_STT_MLX_REPO` remain a legacy startup path only
when no stored pipeline settings exist. See
[Configuration](README.md#configuration) for the full list of env knobs.

`npm run dev` is intentionally long-lived and foreground-only. End users should
use `node scripts/bootstrap.mjs --launch`; do not use its owned background
runtime as the development server.

That canonical command checks repository-local runtime ownership before
install/build mutation. An absent runtime follows doctor → install → build →
start; an owned runtime is verified and reused without automatic
stop/restart/install/build, and unsafe or unverifiable state fails closed.
Applying an update requires the user to confirm no recording is active, run
`npm run app:stop`, and rerun `--launch`. Both new and reused runtimes expose
`AI_NOTE_URL` only after app health, Whisper health, AI NOTE root identity, and
the existing `/api/library` public mode all pass.

## Before you open a PR

Every PR must pass the same gates CI runs. Run them locally first:

```bash
npm run typecheck && npm run lint && npm test && npm run check:links && npm run build
```

- **typecheck** — `tsc --noEmit`, TypeScript strict.
- **lint** — ESLint.
- **test** — Vitest (please add or update tests for behavior changes).
- **check:links** — every relative link in Markdown must resolve to a real file.
- **build** — `next build` must pass with **no secrets, DB, or env** set.

## Branch & PR flow

1. Fork (or branch) and create a **feature branch** off `main`
   (e.g. `feat/export-pdf`, `fix/whisper-timeout`).
2. Make your change; keep it focused and small where possible.
3. Ensure the gate command above passes.
4. Open a **pull request** and fill in the
   [PR template](.github/pull_request_template.md). Add screenshots for UI
   changes. The README screenshots in `docs/media/` are captured from
   **synthetic seed data only** (a throwaway workspace/folder and one demo
   meeting) — never real recordings, transcripts, participant names, or local
   paths. When regenerating them, seed a temp `data/` (library.json + one
   summarized meeting) and a temp `glossary.json`, run the app on `127.0.0.1`,
   and crop out any dev overlay.
5. Wait for **CI to go green** and address review feedback.
6. PRs are merged via **squash merge**, so the PR title becomes the commit — make
   it a good one (see below).

For deterministic browser regression, install the pinned Chromium once and use
the repository-owned synthetic commands:

```bash
npm run test:e2e:install
npm run test:e2e:doctor
npm run test:e2e
```

The scenario uses an allowlisted temporary snapshot, empty `data/`, synthetic
`HOME`, disabled worker, disconnected Whisper, and no external browser traffic.
Chrome DevTools MCP is optional qualitative inspection, not a gate or runtime
dependency. See [ADR 0020](docs/decisions/0020-deterministic-synthetic-browser-verification.md).

The `windows-latest` merge job pins Node 22, runs `npm ci`, the targeted
setup/bootstrap/Codex regression tests, a no-secrets build, pinned Chromium
installation, and the Playwright doctor. Its browser command is limited to the
existing `e2e/smoke.spec.ts` at `desktop-1440`, `mobile-390`, and `mobile-320`;
the runner-owned source snapshot path intentionally contains a space. This is
install/build plus synthetic first-use browser coverage, not an end-to-end run
of the real bootstrap lifecycle. Runtime lifecycle is covered by injected
regression tests, while browser hydration uses empty synthetic data. The job
does not use a microphone, user data, `uv`, `ffmpeg`, a Whisper model or
service, Codex login, a local provider, or external browser network.

The real-data pipeline benchmark is never a unit, build, or Playwright gate.
Run `npm run benchmark:pipeline -- --meeting-id <exact-id>` only after explicitly
approving that meeting's audio/transcript/glossary and configured provider use.
It keeps source artifacts read-only and writes only a private
`.ai-note-runtime/benchmarks/` snapshot. Do not commit or paste its transcript,
audio, corrected output, or provider output into test fixtures, screenshots,
terminal logs, or review comments. See
[ADR 0024](docs/decisions/0024-quality-first-meeting-pipeline.md).

## Commit style

We use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`,
`fix:`, `docs:`, `refactor:`, `chore:`, `test:`. Examples:

```
feat: add PDF export for summaries
fix: bind Whisper service to 127.0.0.1 only
docs: clarify Ollama setup in README
```

## A note on language

The v0.1 **UI strings are Korean-only**. Internationalization is on the
[roadmap](README.md#roadmap) and **i18n contributions are very welcome** — if you
add or change user-facing strings, keep them Korean for now (or structure them so
they can be translated).

## Reporting bugs & requesting features

Use the issue templates:
[bug report](.github/ISSUE_TEMPLATE/bug_report.md) ·
[feature request](.github/ISSUE_TEMPLATE/feature_request.md).

For anything security-sensitive, see [SECURITY.md](SECURITY.md) first.
