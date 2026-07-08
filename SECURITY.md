# Security Policy

AI NOTE is a **local-first, single-user** desktop web app. Understanding that
shape is the fastest way to understand its security posture.

## Threat model

- **Local only.** The Next.js server and the Whisper transcription service both
  bind to `127.0.0.1` — never your LAN or the public internet. Nothing is
  exposed to other machines unless you deliberately reconfigure it.
- **No accounts, no stored keys.** Summaries run through a CLI you are already
  signed in to (Claude / Codex) or a local model (Ollama). AI NOTE never asks
  for, stores, or transmits an API key.
- **No telemetry.** There are no analytics and no outbound calls. Recordings,
  transcripts, and summaries live under `data/` (gitignored) and never leave
  your disk.

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
