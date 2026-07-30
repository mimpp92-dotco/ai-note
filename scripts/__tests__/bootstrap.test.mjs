import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  INTERNAL_SUPERVISOR_COMMAND,
  browserOpenSpec,
  buildBootstrapCommandPlan,
  buildRuntimeCommandPlan,
  canonicalAppUrl,
  classifyRuntimeOwnership,
  createOwnedChildCleanup,
  isAiNoteRootHtml,
  isSupportedLibraryResponse,
  isWhisperFfmpegMissing,
  isWhisperHealthReady,
  openBrowserWithFallback,
  parseBootstrapCommand,
  readRuntimeOwnership,
  repositoryRootFromScriptUrl,
  resolveRuntimePaths,
  runLaunchFlow,
  runStatus,
  startOnAvailablePort,
  stopOwnedRuntime,
  waitForHealth,
} from "../bootstrap.mjs";

const tempDirectories = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("bootstrap CLI contract", () => {
  it("accepts only the canonical public commands and the internal supervisor mode", () => {
    expect(parseBootstrapCommand(["--launch"])).toBe("launch");
    expect(parseBootstrapCommand(["start"])).toBe("start");
    expect(parseBootstrapCommand(["status"])).toBe("status");
    expect(parseBootstrapCommand(["stop"])).toBe("stop");
    expect(parseBootstrapCommand([INTERNAL_SUPERVISOR_COMMAND])).toBe("supervisor");
  });

  it.each([
    [],
    ["launch"],
    ["--launch", "extra"],
    ["start", "--port", "3001"],
    ["--help"],
    ["unknown"],
  ])("rejects unsupported arguments: %j", (args) => {
    expect(() => parseBootstrapCommand(args)).toThrow(/지원하지 않는 bootstrap 명령/);
  });
});

describe("repository-owned paths and commands", () => {
  it("derives the repository root from this script location instead of cwd", () => {
    const scriptUrl = pathToFileURL(join("/tmp", "elsewhere", "ai-note", "scripts", "bootstrap.mjs"));
    expect(repositoryRootFromScriptUrl(scriptUrl)).toBe(
      resolve("/tmp", "elsewhere", "ai-note"),
    );
  });

  it("keeps all runtime metadata and logs in one exact repository-local directory", () => {
    const repositoryRoot = resolve("/tmp", "ai-note");
    expect(resolveRuntimePaths(repositoryRoot)).toEqual({
      directory: join(repositoryRoot, ".ai-note-runtime"),
      state: join(repositoryRoot, ".ai-note-runtime", "state.json"),
      heartbeat: join(repositoryRoot, ".ai-note-runtime", "heartbeat.json"),
      appLog: join(repositoryRoot, ".ai-note-runtime", "app.log"),
      whisperLog: join(repositoryRoot, ".ai-note-runtime", "whisper.log"),
      supervisorLog: join(repositoryRoot, ".ai-note-runtime", "supervisor.log"),
    });
  });

  it("constructs doctor, HUSKY-disabled npm ci, and build in canonical order", () => {
    const repositoryRoot = resolve("/tmp", "ai-note");
    expect(
      buildBootstrapCommandPlan({
        repositoryRoot,
        nodeExecutable: "/opt/node",
        npmExecutable: "npm",
      }),
    ).toEqual([
      {
        name: "doctor",
        command: "/opt/node",
        args: [join(repositoryRoot, "scripts", "setup.mjs")],
        env: {},
      },
      {
        name: "dependencies",
        command: "npm",
        args: ["ci"],
        env: { HUSKY: "0" },
      },
      {
        name: "build",
        command: "npm",
        args: ["run", "build"],
        env: {},
      },
    ]);
  });

  it("constructs both runtime children with loopback ports only in child env", () => {
    const repositoryRoot = resolve("/tmp", "AI NOTE with spaces");
    const uvExecutable = "C:\\Program Files\\uv bin\\uv.exe";
    const commands = buildRuntimeCommandPlan({
      repositoryRoot,
      appPort: 3004,
      whisperPort: 8128,
      nodeExecutable: "/opt/node",
      uvExecutable,
    });

    expect(commands.app).toEqual({
      command: "/opt/node",
      args: [
        join(repositoryRoot, "node_modules", "next", "dist", "bin", "next"),
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        "3004",
      ],
      env: {
        HOSTNAME: "127.0.0.1",
        PORT: "3004",
        LOCAL_STT_HOST: "127.0.0.1",
        LOCAL_STT_PORT: "8128",
      },
    });
    expect(commands.whisper).toEqual({
      command: uvExecutable,
      args: [
        "run",
        "--project",
        join(repositoryRoot, "whisper"),
        "python",
        join(repositoryRoot, "whisper", "server.py"),
      ],
      env: {
        LOCAL_STT_HOST: "127.0.0.1",
        LOCAL_STT_PORT: "8128",
      },
    });
    expect(commands.app).not.toHaveProperty("shell");
    expect(commands.whisper).not.toHaveProperty("shell");
  });

  it("never falls back to a bare uv executable when the doctor path was not supplied", () => {
    expect(() =>
      buildRuntimeCommandPlan({
        repositoryRoot: resolve("/tmp", "ai-note"),
        appPort: 3004,
        whisperPort: 8128,
        nodeExecutable: "/opt/node",
      }),
    ).toThrow(/uv executable/);
  });
});

describe("bounded port selection", () => {
  it("skips an occupied default and retries a bind race on the next candidate", async () => {
    const probed = [];
    const launched = [];
    const result = await startOnAvailablePort({
      startPort: 3000,
      candidateCount: 4,
      probePort: async (port) => {
        probed.push(port);
        return port !== 3000;
      },
      launchCandidate: async (port) => {
        launched.push(port);
        return port === 3001
          ? { kind: "bind-conflict" }
          : { kind: "started", child: { pid: 9000 + port } };
      },
    });

    expect(result.port).toBe(3002);
    expect(result.child.pid).toBe(12002);
    expect(probed).toEqual([3000, 3001, 3002]);
    expect(launched).toEqual([3001, 3002]);
  });

  it("fails clearly when the bounded candidate range is exhausted", async () => {
    await expect(
      startOnAvailablePort({
        startPort: 8123,
        candidateCount: 3,
        probePort: async () => false,
        launchCandidate: async () => {
          throw new Error("must not launch an occupied port");
        },
      }),
    ).rejects.toThrow(/8123-8125.*사용 가능한 loopback port/);
  });
});

describe("health readiness", () => {
  it("retries injected probes until the endpoint is ready", async () => {
    let now = 0;
    let probes = 0;
    const result = await waitForHealth({
      name: "app",
      url: "http://127.0.0.1:3000/",
      timeoutMs: 100,
      intervalMs: 10,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      probe: async () => {
        probes += 1;
        return probes === 3 ? { ready: true } : { ready: false };
      },
      isReady: (value) => value.ready,
    });

    expect(result).toEqual({ ready: true });
    expect(probes).toBe(3);
  });

  it("throws an endpoint-specific timeout instead of reporting success", async () => {
    let now = 0;
    await expect(
      waitForHealth({
        name: "whisper proxy",
        url: "http://127.0.0.1:3000/api/whisper/health",
        timeoutMs: 25,
        intervalMs: 10,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        probe: async () => ({ connected: false, ready: false }),
        isReady: isWhisperHealthReady,
      }),
    ).rejects.toThrow(
      /whisper proxy health timeout.*http:\/\/127\.0\.0\.1:3000\/api\/whisper\/health/,
    );
  });

  it("requires the app proxy to confirm a connected and ready Whisper", () => {
    expect(isWhisperHealthReady({ connected: true, ok: true, ready: true })).toBe(true);
    expect(isWhisperHealthReady({ connected: false, ok: true, ready: true })).toBe(false);
    expect(isWhisperHealthReady({ connected: true, ok: true, ready: false })).toBe(false);
  });

  it("stops on the current public ffmpeg-missing condition without waiting for timeout", async () => {
    let now = 0;
    let probes = 0;
    await expect(
      waitForHealth({
        name: "whisper",
        url: "http://127.0.0.1:8123/health",
        timeoutMs: 100,
        intervalMs: 10,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        probe: async () => {
          probes += 1;
          return {
            connected: true,
            ok: true,
            ready: false,
            message: "ffmpeg not found; install ffmpeg before transcribing",
          };
        },
        isReady: isWhisperHealthReady,
        terminalError: (value) =>
          isWhisperFfmpegMissing(value)
            ? new Error(
                "ffmpeg가 필요합니다. `node scripts/bootstrap.mjs --launch`를 다시 실행하세요.",
              )
            : null,
      }),
    ).rejects.toThrow(/ffmpeg.*bootstrap\.mjs --launch/);
    expect(probes).toBe(1);
    expect(now).toBe(0);
  });

  it("does not classify another generic not-ready response as terminal", () => {
    expect(
      isWhisperFfmpegMissing({
        connected: true,
        ok: true,
        ready: false,
        message: "model preparing",
      }),
    ).toBe(false);
  });
});

describe("first-use content surface validators", () => {
  it("identifies the AI NOTE root HTML without accepting an arbitrary page", () => {
    expect(isAiNoteRootHtml("<html><head><title>AI NOTE</title></head></html>")).toBe(true);
    expect(isAiNoteRootHtml("<html><head><title>Other app</title></head></html>")).toBe(false);
    expect(isAiNoteRootHtml({ title: "AI NOTE" })).toBe(false);
  });

  it.each(["ready", "degraded_last_good", "degraded_fallback"])(
    "accepts the supported public library mode %s",
    (mode) => {
      expect(isSupportedLibraryResponse({ mode })).toBe(true);
    },
  );

  it("rejects malformed and unsupported library responses", () => {
    expect(isSupportedLibraryResponse(null)).toBe(false);
    expect(isSupportedLibraryResponse({})).toBe(false);
    expect(isSupportedLibraryResponse({ mode: "corrupt" })).toBe(false);
    expect(isSupportedLibraryResponse({ mode: "unsupported_version" })).toBe(false);
  });
});

describe("owned pre-ready child cleanup", () => {
  it("terminates only acquired child handles and does so once across interrupt/error races", async () => {
    const first = { pid: 1001 };
    const second = { pid: 1002 };
    const unrelated = { pid: 9000 };
    const terminateChild = vi.fn(async () => {});
    const cleanup = createOwnedChildCleanup({ terminateChild });
    cleanup.track(first);
    cleanup.track(second);

    await Promise.all([
      cleanup.cleanupAll(),
      cleanup.cleanupChild(first),
      cleanup.cleanupAll(),
      cleanup.cleanupChild(unrelated),
    ]);

    expect(terminateChild).toHaveBeenCalledTimes(2);
    expect(terminateChild).toHaveBeenCalledWith(first);
    expect(terminateChild).toHaveBeenCalledWith(second);
    expect(terminateChild).not.toHaveBeenCalledWith(unrelated);
  });
});

describe("browser opening", () => {
  const url = "http://localhost:3007/?safe=1&literal=$(touch nope)";

  it("passes the literal URL as one argv value without shell interpolation", () => {
    expect(browserOpenSpec({ platform: "darwin", env: {}, url })).toEqual({
      command: "open",
      args: [url],
    });
    expect(browserOpenSpec({ platform: "win32", env: {}, url })).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
    expect(
      browserOpenSpec({
        platform: "linux",
        env: { DISPLAY: ":0" },
        url,
      }),
    ).toEqual({
      command: "xdg-open",
      args: [url],
    });
  });

  it("keeps server success and returns exact fallback guidance when headless", async () => {
    const open = vi.fn();
    const result = await openBrowserWithFallback({
      platform: "linux",
      env: {},
      url,
      open,
    });

    expect(open).not.toHaveBeenCalled();
    expect(result.opened).toBe(false);
    expect(result.message).toContain(url);
    expect(result.message).toMatch(/에이전트 browser surface/);
  });

  it("keeps server success when the supported opener fails", async () => {
    const result = await openBrowserWithFallback({
      platform: "darwin",
      env: {},
      url,
      open: async () => {
        throw new Error("opener unavailable");
      },
    });

    expect(result.opened).toBe(false);
    expect(result.message).toContain(url);
  });
});

describe("runtime ownership and safe stop", () => {
  const repositoryRoot = resolve("/tmp", "ai-note");
  const state = {
    schemaVersion: 1,
    repositoryRoot,
    supervisorPid: 4242,
    token: "a".repeat(64),
    appPort: 3002,
    whisperPort: 8125,
    appPid: 5001,
    whisperPid: 5002,
    startedAt: 9_000,
  };
  const heartbeat = {
    schemaVersion: 1,
    repositoryRoot,
    supervisorPid: 4242,
    token: "a".repeat(64),
    updatedAt: 10_000,
  };

  it("recognizes ownership only with a live PID and matching fresh heartbeat token", async () => {
    await expect(
      classifyRuntimeOwnership({
        state,
        heartbeat,
        repositoryRoot,
        nowMs: 10_500,
        heartbeatMaxAgeMs: 2_000,
        isProcessAlive: async (pid) => pid === 4242,
      }),
    ).resolves.toMatchObject({ kind: "owned", state });

    await expect(
      classifyRuntimeOwnership({
        state,
        heartbeat: { ...heartbeat, token: "b".repeat(64) },
        repositoryRoot,
        nowMs: 10_500,
        heartbeatMaxAgeMs: 2_000,
        isProcessAlive: async () => true,
      }),
    ).resolves.toMatchObject({ kind: "unsafe", reason: "ownership_token_mismatch" });

    await expect(
      classifyRuntimeOwnership({
        state,
        heartbeat,
        repositoryRoot,
        nowMs: 20_000,
        heartbeatMaxAgeMs: 2_000,
        isProcessAlive: async () => true,
      }),
    ).resolves.toMatchObject({ kind: "stale", reason: "heartbeat_stale" });
  });

  it("treats a symlinked state file as unsafe without probing the PID", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-note-bootstrap-"));
    tempDirectories.push(root);
    const paths = resolveRuntimePaths(root);
    await mkdir(paths.directory, { mode: 0o700 });
    const outside = join(root, "outside-state.json");
    await writeFile(outside, JSON.stringify(state), { mode: 0o600 });
    await symlink(outside, paths.state);
    await writeFile(paths.heartbeat, JSON.stringify(heartbeat), { mode: 0o600 });
    const isProcessAlive = vi.fn();

    await expect(
      readRuntimeOwnership({
        paths,
        repositoryRoot: root,
        nowMs: 10_500,
        isProcessAlive,
      }),
    ).resolves.toMatchObject({ kind: "unsafe", reason: "state_not_regular" });
    expect(isProcessAlive).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "stale", reason: "heartbeat_stale" },
    { kind: "unsafe", reason: "state_unreadable" },
    { kind: "absent", reason: "state_missing" },
  ])("never signals an unowned supervisor: $kind", async (ownership) => {
    const signal = vi.fn();
    await expect(
      stopOwnedRuntime({
        readOwnership: async () => ownership,
        signal,
      }),
    ).rejects.toThrow(/ownership 확인 실패/);
    expect(signal).not.toHaveBeenCalled();
  });

  it("signals only the supervisor proven by current ownership", async () => {
    const signal = vi.fn();
    const result = await stopOwnedRuntime({
      readOwnership: async () => ({ kind: "owned", state }),
      signal,
    });

    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(result).toEqual({ stoppedPid: 4242 });
  });
});

describe("launch orchestration", () => {
  const readyValue = (name) => {
    if (name === "app") return { ready: true };
    if (name === "whisper") return { connected: true, ok: true, ready: true };
    if (name === "root") return "<html><head><title>AI NOTE</title></head></html>";
    if (name === "library") return { mode: "ready" };
    throw new Error(`unexpected readiness probe: ${name}`);
  };

  it("checks absence before mutation, then runs install/build/start and all four probes", async () => {
    const repositoryRoot = resolve("/tmp", "ai-note");
    const events = [];
    const healthUrls = [];
    const output = [];
    const commandPlan = buildBootstrapCommandPlan({
      repositoryRoot,
      nodeExecutable: "/opt/node",
      npmExecutable: "npm",
    });

    const result = await runLaunchFlow({
      repositoryRoot,
      install: true,
      readOwnership: async () => {
        events.push("ownership");
        return { kind: "absent", reason: "state_missing" };
      },
      commandPlan,
      runCommand: async (spec) => {
        events.push(spec.name);
      },
      startRuntime: async () => {
        events.push("start-runtime");
        return { appPort: 3003, whisperPort: 8126 };
      },
      waitForEndpoint: async ({ name, url, isReady }) => {
        events.push(name);
        healthUrls.push(url);
        expect(isReady(readyValue(name))).toBe(true);
      },
      openBrowser: async ({ url }) => {
        events.push("browser");
        expect(url).toBe("http://localhost:3003");
        return { opened: true };
      },
      writeLine: (line) => output.push(line),
    });

    expect(events).toEqual([
      "ownership",
      "doctor",
      "dependencies",
      "build",
      "start-runtime",
      "app",
      "whisper",
      "root",
      "library",
      "browser",
    ]);
    expect(healthUrls).toEqual([
      "http://localhost:3003/",
      "http://localhost:3003/api/whisper/health",
      "http://localhost:3003/",
      "http://localhost:3003/api/library",
    ]);
    expect(output).toEqual(["AI_NOTE_URL=http://localhost:3003"]);
    expect(result.url).toBe(canonicalAppUrl(3003));
    expect(result.mode).toBe("started");
  });

  it("reuses an owned runtime without install/build/start and reports the unapplied update", async () => {
    const repositoryRoot = resolve("/tmp", "ai-note");
    const runCommand = vi.fn();
    const startRuntime = vi.fn();
    const openBrowser = vi.fn(async () => ({ opened: true }));
    const output = [];
    const state = {
      schemaVersion: 1,
      repositoryRoot,
      supervisorPid: 4242,
      token: "a".repeat(64),
      appPort: 3009,
      whisperPort: 8130,
      appPid: 5001,
      whisperPid: 5002,
      startedAt: 9_000,
    };

    const result = await runLaunchFlow({
      repositoryRoot,
      install: true,
      readOwnership: async () => ({ kind: "owned", state }),
      commandPlan: buildBootstrapCommandPlan({ repositoryRoot }),
      runCommand,
      startRuntime,
      waitForEndpoint: async ({ name, isReady }) => {
        expect(isReady(readyValue(name))).toBe(true);
      },
      openBrowser,
      writeLine: (line) => output.push(line),
    });

    expect(runCommand).not.toHaveBeenCalled();
    expect(startRuntime).not.toHaveBeenCalled();
    expect(openBrowser).toHaveBeenCalledWith({ url: "http://localhost:3009" });
    expect(output).toContain("AI_NOTE_URL=http://localhost:3009");
    expect(output.join("\n")).toMatch(/이번 설치\/업데이트.*적용되지 않았/);
    expect(output.join("\n")).toContain("npm run app:stop");
    expect(output.join("\n")).toContain("node scripts/bootstrap.mjs --launch");
    expect(result.mode).toBe("reused");
  });

  it.each([
    { kind: "stale", reason: "heartbeat_stale" },
    { kind: "unsafe", reason: "state_invalid" },
  ])("fails closed before mutation for an untrusted runtime: $kind", async (ownership) => {
    const runCommand = vi.fn();
    const startRuntime = vi.fn();
    const openBrowser = vi.fn();
    const output = [];

    await expect(
      runLaunchFlow({
        repositoryRoot: resolve("/tmp", "ai-note"),
        install: true,
        readOwnership: async () => ownership,
        commandPlan: [{ name: "doctor" }],
        runCommand,
        startRuntime,
        waitForEndpoint: vi.fn(),
        openBrowser,
        writeLine: (line) => output.push(line),
      }),
    ).rejects.toThrow(/runtime.*안전하게 확인/);

    expect(runCommand).not.toHaveBeenCalled();
    expect(startRuntime).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(output).toEqual([]);
  });

  it("sanitizes a malformed content-surface failure and never prints a premature URL", async () => {
    const output = [];
    let caught;
    try {
      await runLaunchFlow({
        repositoryRoot: resolve("/tmp", "ai-note"),
        install: true,
        readOwnership: async () => ({ kind: "absent", reason: "state_missing" }),
        commandPlan: [],
        runCommand: vi.fn(),
        startRuntime: async () => ({ appPort: 3003, whisperPort: 8126 }),
        waitForEndpoint: async ({ name }) => {
          if (name === "library") {
            throw new Error('private body={"mode":"unsupported_version"} path=/secret');
          }
        },
        openBrowser: vi.fn(),
        writeLine: (line) => output.push(line),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe("AI NOTE first-use readiness 확인에 실패했습니다.");
    expect(caught.message).not.toMatch(/private|unsupported_version|secret/);
    expect(output.some((line) => line.startsWith("AI_NOTE_URL="))).toBe(false);
  });
});

describe("owned runtime status", () => {
  it("prints the URL only after app, Whisper, root identity, and degraded library are supported", async () => {
    const repositoryRoot = resolve("/tmp", "ai-note");
    const paths = resolveRuntimePaths(repositoryRoot);
    const state = {
      schemaVersion: 1,
      repositoryRoot,
      supervisorPid: 4242,
      token: "a".repeat(64),
      appPort: 3006,
      whisperPort: 8129,
      appPid: 5001,
      whisperPid: 5002,
      startedAt: 9_000,
    };
    const probed = [];
    const output = [];

    await runStatus({
      repositoryRoot,
      paths,
      readOwnership: async () => ({ kind: "owned", state }),
      probeEndpoint: async (url, options) => {
        probed.push([url, options]);
        if (url.endsWith("/api/whisper/health")) {
          return { connected: true, ok: true, ready: true };
        }
        if (url.endsWith("/api/library")) return { mode: "degraded_last_good" };
        if (options?.html) return "<html><head><title>AI NOTE</title></head></html>";
        return { ready: true };
      },
      writeLine: (line) => output.push(line),
    });

    expect(probed).toEqual([
      ["http://localhost:3006/", undefined],
      ["http://localhost:3006/api/whisper/health", { json: true }],
      ["http://localhost:3006/", { html: true }],
      ["http://localhost:3006/api/library", { json: true }],
    ]);
    expect(output).toContain("AI_NOTE_URL=http://localhost:3006");
    expect(output).toContain("app=ready");
    expect(output).toContain("whisper=ready");
    expect(output).toContain("root=ready");
    expect(output).toContain("library=degraded_last_good");
    expect(output.join("\n")).not.toContain(String(state.supervisorPid));
    expect(output.join("\n")).not.toContain(paths.appLog);
  });

  it("reports a safe fixed failure and withholds the URL for an unsupported library body", async () => {
    const output = [];

    await expect(
      runStatus({
        repositoryRoot: resolve("/tmp", "ai-note"),
        paths: resolveRuntimePaths(resolve("/tmp", "ai-note")),
        readOwnership: async () => ({
          kind: "owned",
          state: {
            schemaVersion: 1,
            repositoryRoot: resolve("/tmp", "ai-note"),
            supervisorPid: 4242,
            token: "a".repeat(64),
            appPort: 3006,
            whisperPort: 8129,
            appPid: 5001,
            whisperPid: 5002,
            startedAt: 9_000,
          },
        }),
        probeEndpoint: async (url, options) => {
          if (url.endsWith("/api/whisper/health")) {
            return { connected: true, ok: true, ready: true };
          }
          if (url.endsWith("/api/library")) return { mode: "unsupported_version" };
          if (options?.html) return "<html><head><title>AI NOTE</title></head></html>";
          return { ready: true };
        },
        writeLine: (line) => output.push(line),
      }),
    ).rejects.toThrow(/^AI NOTE runtime readiness 확인에 실패했습니다\.$/);

    expect(output).toContain("library=not_ready");
    expect(output.some((line) => line.startsWith("AI_NOTE_URL="))).toBe(false);
    expect(output.join("\n")).not.toMatch(/unsupported_version|token|pid=|\/secret/);
  });

  it("surfaces static ffmpeg installation and relaunch guidance without a generic wait", async () => {
    const repositoryRoot = resolve("/tmp", "ai-note");
    const output = [];
    await expect(
      runStatus({
        repositoryRoot,
        paths: resolveRuntimePaths(repositoryRoot),
        readOwnership: async () => ({
          kind: "owned",
          state: {
            schemaVersion: 1,
            repositoryRoot,
            supervisorPid: 4242,
            token: "a".repeat(64),
            appPort: 3006,
            whisperPort: 8129,
            appPid: 5001,
            whisperPid: 5002,
            startedAt: 9_000,
          },
        }),
        probeEndpoint: async (url, options) => {
          if (url.endsWith("/api/whisper/health")) {
            return {
              connected: true,
              ok: true,
              ready: false,
              message: "ffmpeg not found; install ffmpeg before transcribing",
            };
          }
          if (url.endsWith("/api/library")) return { mode: "ready" };
          if (options?.html) return "<html><head><title>AI NOTE</title></head></html>";
          return { ready: true };
        },
        writeLine: (line) => output.push(line),
      }),
    ).rejects.toThrow(/brew install ffmpeg.*choco install ffmpeg.*bootstrap\.mjs --launch/su);

    expect(output).toContain("whisper=ffmpeg_missing");
    expect(output.some((line) => line.startsWith("AI_NOTE_URL="))).toBe(false);
  });
});
