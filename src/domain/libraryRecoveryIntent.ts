import {
  isAbsolute,
  resolve,
} from "node:path";

import { z } from "zod";

const canonicalUuid = z.string()
  .uuid()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const LIBRARY_RECOVERY_PHASES = [
  "intent_created",
  "archive_published",
  "publish_published",
  "restore_prepared",
  "restore_published",
  "restore_verified",
  "aborted",
] as const;

export const libraryRecoveryIntentSchema = z.object({
  schemaVersion: z.literal(1),
  recoveryId: canonicalUuid,
  oldCanonicalSha256: sha256,
  newLibraryId: canonicalUuid,
  newDocumentSha256: sha256,
  phase: z.enum(LIBRARY_RECOVERY_PHASES),
}).strict().superRefine((intent, context) => {
  if (intent.oldCanonicalSha256 === intent.newDocumentSha256) {
    context.addIssue({
      code: "custom",
      path: ["newDocumentSha256"],
      message: "old and new recovery hashes must differ",
    });
  }
});

export type LibraryRecoveryIntent = z.infer<typeof libraryRecoveryIntentSchema>;

export function safeParseRecoveryIntent(input: unknown):
  | { success: true; data: LibraryRecoveryIntent }
  | { success: false; error: z.ZodError } {
  const result = libraryRecoveryIntentSchema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  return result;
}

function assertNoDuplicateTopLevelFields(text: string): void {
  const keys = new Set<string>();
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let expectingKey = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character !== '"') continue;
      inString = false;
      if (depth === 1 && expectingKey) {
        let cursor = index + 1;
        while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
        if (text[cursor] === ":") {
          let key: string;
          try {
            key = JSON.parse(text.slice(stringStart, index + 1)) as string;
          } catch {
            throw new Error("recovery_intent_invalid_json");
          }
          if (keys.has(key)) throw new Error("recovery_intent_duplicate_field");
          keys.add(key);
          expectingKey = false;
        }
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      stringStart = index;
      continue;
    }
    if (character === "{") {
      depth += 1;
      if (depth === 1) expectingKey = true;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      continue;
    }
    if (character === "," && depth === 1) expectingKey = true;
  }
}

export function parseRecoveryIntentText(text: string): LibraryRecoveryIntent {
  assertNoDuplicateTopLevelFields(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("recovery_intent_invalid_json");
  }
  const result = safeParseRecoveryIntent(parsed);
  if (!result.success) throw new Error("recovery_intent_invalid");
  return result.data;
}

export interface RecoveryBasenames {
  intent: string;
  newTemp: string;
  archive: string;
  restoreTemp: string;
}

function parseRecoveryId(recoveryId: string): string {
  const result = canonicalUuid.safeParse(recoveryId);
  if (!result.success) throw new Error("invalid_recovery_id");
  return result.data;
}

export function deriveRecoveryBasenames(recoveryId: string): RecoveryBasenames {
  const id = parseRecoveryId(recoveryId);
  return {
    intent: `.library-recovery-${id}.intent.json`,
    newTemp: `.library-recovery-${id}.new.json`,
    archive: `library.archive-${id}.json`,
    restoreTemp: `.library-recovery-${id}.restore.json`,
  };
}

export function validateRecoveryPathObservation(input: {
  rootPath: string;
  recoveryId: string;
  resolvedPaths: Record<keyof RecoveryBasenames, string>;
  componentsNoFollowSafe: boolean;
}): boolean {
  if (!input.componentsNoFollowSafe || !isAbsolute(input.rootPath)) return false;
  let basenames: RecoveryBasenames;
  try {
    basenames = deriveRecoveryBasenames(input.recoveryId);
  } catch {
    return false;
  }
  const root = resolve(input.rootPath);
  return (Object.keys(basenames) as Array<keyof RecoveryBasenames>).every((key) => {
    const observed = input.resolvedPaths[key];
    if (!isAbsolute(observed)) return false;
    return resolve(observed) === resolve(root, basenames[key]);
  });
}
