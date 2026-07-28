import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { atomicWriteFile } from "@/lib/atomicWrite";

export const WHISPER_MODELS = ["large-v3", "large-v3-turbo"] as const;
export const CORRECTION_MODES = ["full", "fast"] as const;

export type WhisperModel = (typeof WHISPER_MODELS)[number];
export type CorrectionMode = (typeof CORRECTION_MODES)[number];

export interface PipelineSettings {
  transcription: { model: WhisperModel };
  correction: { mode: CorrectionMode };
}

export const DEFAULT_PIPELINE_SETTINGS: PipelineSettings = {
  transcription: { model: "large-v3" },
  correction: { mode: "full" },
};

export const pipelineSettingsSchema = z.object({
  transcription: z.object({
    model: z.enum(WHISPER_MODELS),
  }).strict(),
  correction: z.object({
    mode: z.enum(CORRECTION_MODES),
  }).strict(),
}).strict();

const storedPipelineSettingsSchema = pipelineSettingsSchema.extend({
  schemaVersion: z.literal(1),
}).strict();

export type PipelineSettingsReadResult =
  | { state: "default"; settings: PipelineSettings }
  | { state: "stored"; settings: PipelineSettings }
  | { state: "unavailable"; reason: "corrupt" | "unsupported_version" | "io_error" };

export type PipelineSettingsDurability = "durable" | "best_effort" | "pending";

export interface PipelineSettingsWriteResult {
  settings: PipelineSettings;
  durability: PipelineSettingsDurability;
}

const writeQueues = new Map<string, Promise<void>>();

export function pipelineSettingsPath(): string {
  return join(process.cwd(), "data", "pipeline-settings.json");
}

function cloneSettings(settings: PipelineSettings): PipelineSettings {
  return {
    transcription: { model: settings.transcription.model },
    correction: { mode: settings.correction.mode },
  };
}

function missingFile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function isWhisperModel(value: unknown): value is WhisperModel {
  return typeof value === "string"
    && (WHISPER_MODELS as readonly string[]).includes(value);
}

export async function readPipelineSettings(): Promise<PipelineSettingsReadResult> {
  const path = pipelineSettingsPath();
  let raw: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      return { state: "unavailable", reason: "io_error" };
    }
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (missingFile(error)) {
      return {
        state: "default",
        settings: cloneSettings(DEFAULT_PIPELINE_SETTINGS),
      };
    }
    return { state: "unavailable", reason: "io_error" };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { state: "unavailable", reason: "corrupt" };
  }
  if (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && "schemaVersion" in value
    && (value as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    return { state: "unavailable", reason: "unsupported_version" };
  }
  const parsed = storedPipelineSettingsSchema.safeParse(value);
  if (!parsed.success) return { state: "unavailable", reason: "corrupt" };
  return {
    state: "stored",
    settings: cloneSettings(parsed.data),
  };
}

async function inWriteQueue<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(() => undefined, () => undefined);
  writeQueues.set(path, settled);
  try {
    return await run;
  } finally {
    if (writeQueues.get(path) === settled) writeQueues.delete(path);
  }
}

export async function writePipelineSettings(input: unknown): Promise<PipelineSettingsWriteResult> {
  const settings = cloneSettings(pipelineSettingsSchema.parse(input));
  const path = pipelineSettingsPath();
  return inWriteQueue(path, async () => {
    const commit = await atomicWriteFile(
      path,
      `${JSON.stringify({ schemaVersion: 1, ...settings }, null, 2)}\n`,
    );
    switch (commit.state) {
      case "committed_durable":
        return { settings, durability: "durable" };
      case "committed_best_effort":
        return { settings, durability: "best_effort" };
      case "committed_durability_pending":
        return { settings, durability: "pending" };
      case "not_committed":
        throw new Error("pipeline_settings_not_committed");
    }
  });
}
