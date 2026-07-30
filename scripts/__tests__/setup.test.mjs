import { describe, expect, it } from "vitest";

import {
  checkNode,
  codexWindowsAppsWarning,
  doctorCompletionMessage,
  nodeMajor,
  normalizeChildEnvironment,
  parseOllamaModels,
  resolveFfmpeg,
  which,
} from "../setup.mjs";

// setup.mjs is the dependency-free install doctor. Only its PURE functions are
// unit-tested here (with injected deps) — the real spawn/fetch/print live behind
// the CLI guard so importing this module in CI (no uv/ffmpeg/ollama) is inert.

describe("nodeMajor / checkNode", () => {
  it("parses the major version from a real version string", () => {
    expect(nodeMajor("20.11.0")).toBe(20);
    expect(nodeMajor("22.1.0")).toBe(22);
    expect(nodeMajor("v18.19.0")).toBe(18); // tolerate a leading v
  });

  it("passes on Node >= 20", () => {
    expect(checkNode("20.11.0").ok).toBe(true);
    expect(checkNode("22.1.0").ok).toBe(true);
  });

  it("fails on Node < 20 with a remediation detail", () => {
    const r = checkNode("18.19.0");
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/20/);
  });
});

describe("which (injectable, cross-platform)", () => {
  const deps = (paths, platform = "linux") => ({
    env: { PATH: ["/usr/bin", "/usr/local/bin"].join(platform === "win32" ? ";" : ":") },
    platform,
    existsSync: (p) => paths.includes(p),
  });

  it("finds a binary on PATH (posix)", () => {
    expect(which("uv", deps(["/usr/local/bin/uv"]))).toBe("/usr/local/bin/uv");
  });

  it("returns null when absent", () => {
    expect(which("uv", deps([]))).toBe(null);
  });

  it("applies PATHEXT extensions on win32", () => {
    const d = {
      env: { PATH: "C:\\bin", PATHEXT: ".COM;.EXE;.CMD" },
      platform: "win32",
      existsSync: (p) => p === "C:\\bin\\ffmpeg.EXE",
    };
    expect(which("ffmpeg", d)).toBe("C:\\bin\\ffmpeg.EXE");
  });

  it("reads Windows Path and mixed-case PATHEXT keys case-insensitively", () => {
    const d = {
      env: { Path: "C:\\Program Files\\uv bin", PaThExT: ".Com;.Exe;.Cmd" },
      platform: "win32",
      existsSync: (p) => p === "C:\\Program Files\\uv bin\\uv.Exe",
    };
    expect(which("uv", d)).toBe("C:\\Program Files\\uv bin\\uv.Exe");
  });
});

describe("Windows child environment normalization", () => {
  it("matches Node's deterministic inherited duplicate precedence without merging PATH", () => {
    const env = normalizeChildEnvironment({
      inheritedEnv: {
        Path: "C:\\inherited-path",
        PATH: "C:\\node-precedence",
        PaThExT: ".EXE;.CMD",
        TEMP: "C:\\Temp",
      },
      platform: "win32",
    });

    expect(Object.keys(env).filter((key) => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
    expect(env.PATH).toBe("C:\\node-precedence");
    expect(env.PATH).not.toContain("C:\\inherited-path");
    expect(Object.keys(env).filter((key) => key.toUpperCase() === "PATHEXT")).toEqual([
      "PaThExT",
    ]);
  });

  it("lets an explicit child override win case-insensitively as one entry", () => {
    const env = normalizeChildEnvironment({
      inheritedEnv: {
        PATH: "C:\\inherited",
        Path: "C:\\ignored-inherited",
        TEMP: "C:\\Temp",
      },
      overrideEnv: {
        pAtH: "C:\\Program Files\\AI NOTE\\bin",
      },
      platform: "win32",
    });

    expect(Object.keys(env).filter((key) => key.toUpperCase() === "PATH")).toEqual(["pAtH"]);
    expect(env.pAtH).toBe("C:\\Program Files\\AI NOTE\\bin");
    expect(env.pAtH).not.toContain("C:\\inherited");
    expect(env.TEMP).toBe("C:\\Temp");
  });
});

describe("Codex Windows desktop package warning", () => {
  const env = { ProgramFiles: "C:\\Program Files" };

  it("warns only when the first resolved Codex path is clearly inside the desktop package", () => {
    const warning = codexWindowsAppsWarning({
      codexPath:
        "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.2.3.0_x64__8wekyb3d8bbwe\\codex.exe",
      env,
      platform: "win32",
    });

    expect(warning).toMatch(/데스크톱 앱/);
    expect(warning).toMatch(/독립 Codex CLI/);
    expect(warning).toMatch(/PATH/);
  });

  it("does not warn for a standalone CLI or a non-Windows platform", () => {
    expect(
      codexWindowsAppsWarning({
        codexPath: "C:\\Tools\\codex\\codex.exe",
        env,
        platform: "win32",
      }),
    ).toBe(null);
    expect(
      codexWindowsAppsWarning({
        codexPath:
          "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.2.3.0_x64__8wekyb3d8bbwe\\codex.exe",
        env,
        platform: "linux",
      }),
    ).toBe(null);
  });
});

describe("resolveFfmpeg (FFMPEG_PATH > candidates > PATH)", () => {
  it("prefers FFMPEG_PATH when it exists", () => {
    const r = resolveFfmpeg({
      env: { FFMPEG_PATH: "/custom/ffmpeg" },
      existsSync: (p) => p === "/custom/ffmpeg",
      which: () => null,
    });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("/custom/ffmpeg");
  });

  it("falls back to a known candidate path", () => {
    const r = resolveFfmpeg({
      env: {},
      existsSync: (p) => p === "/opt/homebrew/bin/ffmpeg",
      which: () => null,
    });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("/opt/homebrew/bin/ffmpeg");
  });

  it("falls back to PATH resolution last", () => {
    const r = resolveFfmpeg({
      env: {},
      existsSync: () => false,
      which: (bin) => (bin === "ffmpeg" ? "/usr/bin/ffmpeg" : null),
    });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("/usr/bin/ffmpeg");
  });

  it("reports not-found with brew/apt/choco guidance", () => {
    const r = resolveFfmpeg({ env: {}, existsSync: () => false, which: () => null });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/brew install ffmpeg/);
    expect(r.detail).toMatch(/apt install ffmpeg/);
    expect(r.detail).toMatch(/choco install ffmpeg/);
  });
});

describe("parseOllamaModels", () => {
  it("extracts model names from an /api/tags payload", () => {
    const data = { models: [{ name: "llama3.1:8b" }, { name: "qwen2.5:7b" }] };
    expect(parseOllamaModels(data)).toEqual(["llama3.1:8b", "qwen2.5:7b"]);
  });

  it("is tolerant of a missing/empty models array", () => {
    expect(parseOllamaModels({})).toEqual([]);
    expect(parseOllamaModels({ models: [] })).toEqual([]);
    expect(parseOllamaModels(null)).toEqual([]);
  });
});

describe("doctor completion guidance", () => {
  it("makes the canonical bootstrap resume command primary", () => {
    const message = doctorCompletionMessage({ blocked: false });
    expect(message).toContain("node scripts/bootstrap.mjs --launch");
    expect(message).toContain("npm run dev");
    expect(message.indexOf("node scripts/bootstrap.mjs --launch")).toBeLessThan(
      message.indexOf("npm run dev"),
    );
  });

  it("uses the same resume command after missing prerequisites are installed", () => {
    expect(doctorCompletionMessage({ blocked: true })).toContain(
      "node scripts/bootstrap.mjs --launch",
    );
  });
});
