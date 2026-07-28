import {
  runProcess,
  type RunProcessOptions,
  type RunProcessResult,
} from "@/services/llm/exec";

export const CLI_HELP_TIMEOUT_MS = 5_000;
export const CLI_HELP_MAX_BUFFER = 64 * 1024;

export type CliHelpRunner = (
  file: string,
  args: string[],
  options: RunProcessOptions,
) => Promise<RunProcessResult>;

export interface CliCapabilityRequest {
  file: string;
  args: readonly string[];
  optionalFlags: readonly string[];
}

export interface CliCapabilityDetector {
  detect(request: CliCapabilityRequest): Promise<Set<string>>;
}

const MALFORMED_HELP = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function cacheKey(request: CliCapabilityRequest): string {
  return JSON.stringify([request.file, request.args]) ?? request.file;
}

function flagPattern(flag: string): RegExp {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `(?:^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`,
    "mu",
  );
}

export function createCliCapabilityDetector(
  runner: CliHelpRunner = runProcess,
): CliCapabilityDetector {
  const helpCache = new Map<string, Promise<string | null>>();

  return {
    async detect(request): Promise<Set<string>> {
      const key = cacheKey(request);
      let pending = helpCache.get(key);
      if (!pending) {
        pending = runner(request.file, [...request.args], {
          timeoutMs: CLI_HELP_TIMEOUT_MS,
          maxBuffer: CLI_HELP_MAX_BUFFER,
        }).then(({ stdout, stderr }) => {
          const output = `${stdout}\n${stderr}`;
          if (
            output.length > CLI_HELP_MAX_BUFFER
            || MALFORMED_HELP.test(output)
          ) return null;
          return output;
        }).catch(() => null);
        helpCache.set(key, pending);
      }

      const output = await pending;
      if (output === null) return new Set();
      return new Set(request.optionalFlags.filter((flag) => (
        flagPattern(flag).test(output)
      )));
    },
  };
}

const defaultDetector = createCliCapabilityDetector();

export async function detectCliCapabilities(
  request: CliCapabilityRequest,
): Promise<Set<string>> {
  return defaultDetector.detect(request);
}
