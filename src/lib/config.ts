import { join } from "node:path";

// Env/config defaults. All read process.env lazily inside functions — never at
// module top-level — so `next build` stays green without any env/secrets.
// whisper address (LOCAL_STT_HOST/PORT) is the contract between app-api and the
// local whisper service.

const DEFAULT_STT_HOST = "127.0.0.1";
const DEFAULT_STT_PORT = 8123;
const DEFAULT_STT_MODEL = "large-v3";
const DEFAULT_STT_LANG = "ko";

export function localSttHost(): string {
  return process.env.LOCAL_STT_HOST ?? DEFAULT_STT_HOST;
}

export function localSttPort(): number {
  const raw = process.env.LOCAL_STT_PORT;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : DEFAULT_STT_PORT;
}

export function localSttBaseUrl(): string {
  return `http://${localSttHost()}:${localSttPort()}`;
}

export function localSttModel(): string {
  return process.env.LOCAL_STT_MODEL ?? DEFAULT_STT_MODEL;
}

// Whisper decode language. Default "ko"; set to "auto" for language detection or
// any Whisper language code (e.g. "en"). Read by the whisper service via env.
export function localSttLang(): string {
  return process.env.LOCAL_STT_LANG ?? DEFAULT_STT_LANG;
}

export function localSttGlossaryPath(): string {
  return process.env.LOCAL_STT_GLOSSARY ?? join(process.cwd(), "glossary.json");
}
