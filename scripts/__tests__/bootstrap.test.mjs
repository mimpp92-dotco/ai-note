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
    const repositoryRoot = resolve("/tmp", "ai-note");
    const commands = buildRuntimeCommandPlan({
      repositoryRoot,
      appPort: 3004,
      whisperPort: 8128,
      nodeExecutable: "/opt/node",
      uvExecutable: "uv",
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
      command: "uv",
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
  it("runs install/build/start/health/browser in order and prints one canonical URL", async () => {
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
      commandPlan,
      runCommand: async (spec) => {
        events.push(spec.name);
      },
      startRuntime: async () => {
        events.push("start-runtime");
        return { appPort: 3003, whisperPort: 8126 };
      },
      waitForEndpoint: async ({ name, url }) => {
        events.push(name);
        healthUrls.push(url);
      },
      openBrowser: async ({ url }) => {
        events.push("browser");
        expect(url).toBe("http://localhost:3003");
        return { opened: true };
      },
      writeLine: (line) => output.push(line),
    });

    expect(events).toEqual([
      "doctor",
      "dependencies",
      "build",
      "start-runtime",
      "app",
      "whisper",
      "browser",
    ]);
    expect(healthUrls).toEqual([
      "http://localhost:3003/",
      "http://localhost:3003/api/whisper/health",
    ]);
    expect(output).toEqual(["AI_NOTE_URL=http://localhost:3003"]);
    expect(result.url).toBe(canonicalAppUrl(3003));
  });
});

describe("owned runtime status", () => {
  it("probes the app and proxied Whisper health through the canonical localhost authority", async () => {
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
        return options?.json
          ? { connected: true, ok: true, ready: true }
          : { ready: true };
      },
      writeLine: (line) => output.push(line),
    });

    expect(probed).toEqual([
      ["http://localhost:3006/", undefined],
      ["http://localhost:3006/api/whisper/health", { json: true }],
    ]);
    expect(output).toContain("AI_NOTE_URL=http://localhost:3006");
    expect(output).toContain(`app=ready log=${paths.appLog}`);
    expect(output).toContain(`whisper=ready log=${paths.whisperLog}`);
  });
});
