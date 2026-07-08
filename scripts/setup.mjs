#!/usr/bin/env node
// AI NOTE 설치 닥터 — 전제 도구(Node·uv·ffmpeg·요약기)를 점검하고 조치를 안내한다.
// 읽기 전용: 파일을 쓰지 않고(있으면 `cp` 명령만 안내), 바이너리를 "실행"하지 않고
// "PATH 존재"만 확인한다(claude/codex 실행 시 인증 프롬프트 hang 회피). 외부 의존 0
// (node: 빌트인 + 글로벌 fetch만) — 그래서 `npm install` 전에도 돈다.
// 실제 프로빙은 전부 아래 CLI 가드 뒤에서만 실행 → 테스트/CI에서 import해도 무해.
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ── 재사용 문구 (앱 UI/서버와 동일하게) ──────────────────────────────
// src/lib/ffmpeg.ts 의 FFMPEG_NOT_FOUND 와 문구 일치.
const FFMPEG_CANDIDATES = [
  "/opt/homebrew/bin/ffmpeg", // macOS (Apple Silicon Homebrew)
  "/usr/local/bin/ffmpeg", // macOS (Intel Homebrew) / common *nix
  "/usr/bin/ffmpeg", // Debian/Ubuntu apt
];
const FFMPEG_NOT_FOUND =
  "ffmpeg not found. Set FFMPEG_PATH or install it — " +
  "macOS: `brew install ffmpeg` · Debian/Ubuntu: `apt install ffmpeg` · " +
  "Windows: `choco install ffmpeg` (or download from ffmpeg.org).";
const UV_INSTALL = "install uv — see https://docs.astral.sh/uv/ (macOS: `brew install uv`)";
const OLLAMA_BASE_URL = "http://127.0.0.1:11434";

// ── 순수 함수 (주입식 의존 → 테스트 가능) ────────────────────────────
export function nodeMajor(versionStr) {
  return parseInt(String(versionStr).replace(/^v/, "").split(".")[0], 10);
}

export function checkNode(versionStr, min = 20) {
  const major = nodeMajor(versionStr);
  const ok = Number.isFinite(major) && major >= min;
  return ok
    ? { ok, detail: `Node ${versionStr}` }
    : { ok, detail: `Node ${versionStr} — need >= ${min} (use nvm or your OS package manager)` };
}

// which()는 실행 없이 PATH를 훑는다. win32는 PATHEXT 확장자를 순회한다.
export function which(bin, { env = {}, platform = process.platform, existsSync: exists } = {}) {
  const isWin = platform === "win32";
  const sep = isWin ? ";" : ":";
  const joiner = isWin ? "\\" : "/";
  const dirs = (env.PATH || "").split(sep).filter(Boolean);
  const exts = isWin ? [...(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";"), ""] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = `${dir}${joiner}${bin}${ext}`;
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveFfmpeg({ env = {}, existsSync: exists, which: whichFn }) {
  const fromEnv = env.FFMPEG_PATH;
  if (fromEnv && exists(fromEnv)) return { ok: true, path: fromEnv };
  for (const candidate of FFMPEG_CANDIDATES) {
    if (exists(candidate)) return { ok: true, path: candidate };
  }
  const onPath = whichFn("ffmpeg");
  if (onPath) return { ok: true, path: onPath };
  return { ok: false, path: null, detail: FFMPEG_NOT_FOUND };
}

export function parseOllamaModels(data) {
  return ((data && data.models) || []).map((m) => m && m.name).filter(Boolean);
}

// ── 부수효과 헬퍼 (가드 뒤에서만 호출) ───────────────────────────────
function realWhich(bin) {
  return which(bin, { env: process.env, platform: process.platform, existsSync });
}

async function probeOllama() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: controller.signal });
    if (!res.ok) return { running: false, models: [] };
    const data = await res.json();
    return { running: true, models: parseOllamaModels(data) };
  } catch {
    return { running: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

const OK = "✓";
const WARN = "⚠";
const FAIL = "✗";
function line(mark, label, detail) {
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("AI NOTE 설치 점검\n");
  let blocked = false;

  // 1. Node (하드 블로커)
  const node = checkNode(process.versions.node);
  line(node.ok ? OK : FAIL, "Node", node.detail);
  if (!node.ok) blocked = true;

  // 2. uv (하드 블로커)
  const uv = realWhich("uv");
  line(uv ? OK : FAIL, "uv", uv || UV_INSTALL);
  if (!uv) blocked = true;

  // 3. ffmpeg (하드 블로커)
  const ffmpeg = resolveFfmpeg({ env: process.env, existsSync, which: realWhich });
  line(ffmpeg.ok ? OK : FAIL, "ffmpeg", ffmpeg.ok ? ffmpeg.path : ffmpeg.detail);
  if (!ffmpeg.ok) blocked = true;

  // 4. 요약기 (정보성 — 최소 하나 필요, 하드 블로커 아님)
  const claude = realWhich("claude");
  const codex = realWhich("codex");
  const ollama = await probeOllama();
  const summarizers = [];
  if (claude) summarizers.push("claude");
  if (codex) summarizers.push("codex");
  if (ollama.running) summarizers.push("ollama");
  if (summarizers.length > 0) {
    const extra = ollama.running
      ? ` (ollama models: ${ollama.models.length ? ollama.models.join(", ") : "none pulled"})`
      : "";
    line(OK, "요약기", `${summarizers.join(", ")} 감지됨${extra}`);
  } else {
    line(
      WARN,
      "요약기",
      "none — 하나 준비 필요: `claude` 로그인 · `codex` · `ollama serve` + `ollama pull <model>`. " +
        "앱 기동 후 Settings에서 선택.",
    );
  }

  // 5. .env.local (선택)
  if (existsSync(".env.local")) {
    line(OK, ".env.local", "존재");
  } else {
    line(WARN, ".env.local", "없음(기본값으로 동작) — 조정하려면 `cp .env.example .env.local`");
  }

  console.log("");
  if (blocked) {
    console.error(
      "✗ 필수 전제(Node/uv/ffmpeg) 미충족. 위 안내대로 설치 후 다시 실행하세요.\n" +
        "  에이전트: AGENTS.md `## 설치` 참조 · Claude Code: `/setup`",
    );
    process.exit(1);
  }
  console.log(
    "✓ 필수 전제 충족. `npm install && npm run dev` (첫 실행은 whisper 모델 다운로드).\n" +
      "  자동 설치가 필요하면 — 에이전트: AGENTS.md `## 설치` · Claude Code: `/setup`",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
