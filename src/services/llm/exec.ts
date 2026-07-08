import { spawn } from "node:child_process";

// Subprocess helper for CLI adapters. Uses spawn (args as an array — no shell,
// so no command-injection surface) and pipes the prompt via STDIN, never argv
// (transcripts are tens of KB and Korean text inflates byte length ~3×, so argv
// would risk ARG_MAX). Enforces a timeout + max output size.

export interface RunProcessOptions {
  stdin?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RunProcessResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

export async function runProcess(
  file: string,
  args: string[],
  opts: RunProcessOptions = {},
): Promise<RunProcessResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return new Promise<RunProcessResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflow = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    // A pipe can emit 'error' after SIGKILL — swallow so it never crashes the process.
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > maxBuffer) {
        overflow = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < maxBuffer) stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err); // ENOENT when the binary is not installed, etc.
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`process timed out after ${timeoutMs}ms`));
      if (overflow) return reject(new Error("process output exceeded maxBuffer"));
      if (code !== 0) {
        return reject(new Error(`process exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
      resolve({ stdout, stderr });
    });

    // stdin may close early (EPIPE) if the child exits fast — swallow it.
    child.stdin.on("error", () => {});
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}
