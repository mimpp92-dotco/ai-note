# Security Policy

AI NOTE is a **local-first, single-user** desktop web app. Understanding that
shape is the fastest way to understand its security posture.

## Threat model

- **Local only.** The Next.js server and the Whisper transcription service both
  bind to `127.0.0.1` — never your LAN or the public internet. Nothing is
  exposed to other machines unless you deliberately reconfigure it.
- **Loopback request boundary.** Data APIs accept only exact `127.0.0.1` or
  `localhost` Host values. Unsafe methods require an exact same-origin `Origin`,
  and Fetch Metadata rejects cross-site/API document-style requests. Forwarded
  headers are not trusted and CORS is not enabled.
- **No accounts, no stored keys.** Summaries run through a CLI you are already
  signed in to (Claude / Codex) or a local model (Ollama). AI NOTE never asks
  for, stores, or transmits an API key.
- **No telemetry.** There are no analytics and no outbound calls. Recordings,
  transcripts, and summaries live under `data/` (gitignored) and never leave
  your disk.
- **Glossary is local PII.** The domain glossary (`glossary.json`) may contain
  personal names; it is gitignored and never committed. Exported hand-off docs
  (`.md` / `.json`) are written verbatim — AI NOTE does **not** currently scrub
  tokens/emails/PII from them. This is a deliberate local-only trade-off (see
  [ADR 0015](docs/decisions/0015-durable-meeting-tombstone.md)); on a single-user
  machine the export is already as trusted as the rest of `data/`.

Because everything runs locally under the user's own account, the primary risk
surface is **local**: an attacker who already has code execution or file access
on your machine, a malicious dependency, or a bug that causes AI NOTE to bind
somewhere other than `127.0.0.1` or to leak sensitive data into an artifact.
Reports that assume remote/multi-tenant exposure generally do not apply — but if
you find a way to make the app reachable off-localhost, or to exfiltrate data,
that is very much in scope. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for
the module boundaries and data flow.

### In scope

- Unintended network exposure (binding beyond `127.0.0.1`, SSRF, open ports).
- Leakage of audio, transcripts, tokens, or PII into logs or exported artifacts.
- Path traversal or arbitrary file read/write via the API routes.
- Dependency vulnerabilities with a realistic local-exploitation path.

### Out of scope

- Attacks requiring you to intentionally expose the app to a network.
- Social-engineering or physical-access scenarios.
- Issues in third-party summarizer CLIs/models themselves (report those upstream).

## Local service and data controls

- Ollama and Whisper destinations are validated at save/use time as explicit-port
  loopback HTTP URLs; credentials, redirects, paths, query strings, and fragments
  are rejected.
- The app never sends a filesystem path to Whisper. It sends safe meeting and
  dispatch IDs; Whisper derives fixed paths under its configured data root and
  rejects symlinks/containment escapes.
- Whisper persists a service-owned claim with the immutable audio hash before
  model work. Retries/restarts resume the same protocol pair; a changed audio
  identity fails closed.
- Recording finalize validates the MIME allowlist, IDs, timestamps, tombstone,
  and request metadata before reading the unbounded streaming body. It durably
  pins metadata/location in a hidden intent, fsyncs the streamed audio, and only
  exposes a meeting by renaming a complete audio+status+receipt directory.
  Published retries never consume replacement bodies. Hidden intent/receipt
  metadata and audio remain local PII. There is intentionally no application
  byte/duration cap, so local disk exhaustion by the trusted local user remains
  a documented residual risk.
- Permanent deletion first commits a minimal `{id, deletedAt}` tombstone under
  `data/meeting-tombstones/`. That marker permanently fences the ID even if a
  late local producer recreates files. Tombstone and deterministic trash scans
  reject symlinks and malformed state; they never follow or repair an ambiguous
  path. Physical meeting/trash cleanup is retryable and does not remove the
  tombstone.
- Corrupt-library recovery metadata never stores a caller-selected path. A
  strict versioned intent accepts only a canonical lowercase UUID recovery ID,
  old/new SHA-256 identities, the intended new library ID, and an explicit
  publish/restore phase; unknown, duplicate, missing, control, separator,
  absolute, `..`, and non-canonical Unicode fields fail closed. Temp/archive/
  restore basenames are recomputed from the validated ID. Typed path observation
  must prove exact root containment and every-component no-follow safety before
  the pure planner can return any mutation action. Invalid/multiple intent,
  symlink/unsafe path, hash/ID mismatch, or canonical-missing ambiguity returns
  `recovery_conflict`, never cleanup or empty bootstrap.
- Recovery mutation is exposed only for the exact `corrupt` mode and the latest
  opaque fingerprint. The executor archives the original before publishing a
  new registry, atomically replaces every intent phase, and requires directory
  durability for archive/canonical namespace changes. Unsupported durability,
  I/O, or ambiguous restart state fails closed. `data/library-recovery/` and its
  files use private permissions where supported; archives can contain local PII,
  never appear in API/UI paths, and are retained indefinitely until the local
  user removes them.
- API responses use explicit DTOs and static errors. Local absolute paths,
  job/dispatch IDs, provider stdout/stderr, and raw filesystem errors are not
  returned or logged. Export files remain the intentional local hand-off exception
  described above.

## Supported versions

This is an early public project. Only the latest release / `main` receives fixes.

| Version | Supported |
|---|---|
| latest (`main`) | ✅ |
| older | ❌ |

## Reporting a vulnerability

For most issues, please **open a GitHub issue** with steps to reproduce, the
affected version/commit, and your platform.

If the issue is **sensitive** (for example, it could leak private data or
compromise a user before a fix ships), please practice responsible disclosure:
open a minimal issue asking for a private channel — or use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
if enabled on the repository — rather than posting full exploit details
publicly. We will acknowledge your report, work on a fix, and credit you unless
you prefer to remain anonymous.

Thank you for helping keep AI NOTE safe.
