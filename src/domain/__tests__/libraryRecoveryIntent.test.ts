import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  deriveRecoveryBasenames,
  parseRecoveryIntentText,
  safeParseRecoveryIntent,
  validateRecoveryPathObservation,
} from "@/domain/libraryRecoveryIntent";

const RECOVERY_ID = "10000000-0000-4000-8000-000000000001";
const LIBRARY_ID = "20000000-0000-4000-8000-000000000002";
const OLD_HASH = "a".repeat(64);
const NEW_HASH = "b".repeat(64);

function intent() {
  return {
    schemaVersion: 1 as const,
    recoveryId: RECOVERY_ID,
    oldCanonicalSha256: OLD_HASH,
    newLibraryId: LIBRARY_ID,
    newDocumentSha256: NEW_HASH,
    phase: "intent_created" as const,
  };
}

describe("strict library recovery intent", () => {
  it("accepts exactly the versioned semantic fields and no stored paths", () => {
    expect(safeParseRecoveryIntent(intent())).toEqual({ success: true, data: intent() });
    expect(safeParseRecoveryIntent({ ...intent(), archivePath: "/tmp/escape" }).success).toBe(false);
    expect(safeParseRecoveryIntent({ ...intent(), schemaVersion: 2 }).success).toBe(false);
    const missing: Partial<ReturnType<typeof intent>> = { ...intent() };
    delete missing.phase;
    expect(safeParseRecoveryIntent(missing).success).toBe(false);
    expect(safeParseRecoveryIntent({
      ...intent(),
      newDocumentSha256: OLD_HASH,
    }).success).toBe(false);
  });

  it("rejects duplicate JSON fields before normal JSON last-key-wins parsing", () => {
    const text = JSON.stringify(intent()).replace(
      `"recoveryId":"${RECOVERY_ID}"`,
      `"recoveryId":"${RECOVERY_ID}","recoveryId":"${RECOVERY_ID}"`,
    );
    expect(() => parseRecoveryIntentText(text)).toThrowError("recovery_intent_duplicate_field");
  });

  it.each([
    "/absolute",
    "../escape",
    "one/two",
    "one\\two",
    `id\u0000`,
    "１０００００００-００００-４０００-８０００-０００００００００００１",
    "A0000000-0000-4000-8000-000000000001",
  ])("rejects unsafe or non-canonical recovery ID %s", (recoveryId) => {
    expect(safeParseRecoveryIntent({ ...intent(), recoveryId }).success).toBe(false);
  });

  it("derives every basename from the validated recovery ID", () => {
    expect(deriveRecoveryBasenames(RECOVERY_ID)).toEqual({
      intent: `.library-recovery-${RECOVERY_ID}.intent.json`,
      newTemp: `.library-recovery-${RECOVERY_ID}.new.json`,
      archive: `library.archive-${RECOVERY_ID}.json`,
      restoreTemp: `.library-recovery-${RECOVERY_ID}.restore.json`,
    });
    expect(() => deriveRecoveryBasenames("../escape")).toThrowError("invalid_recovery_id");
  });

  it("accepts only exact derived contained paths with every component no-follow safe", () => {
    const rootPath = resolve("/tmp/ai-note-data");
    const basenames = deriveRecoveryBasenames(RECOVERY_ID);
    const paths = Object.fromEntries(Object.entries(basenames).map(([key, basename]) => [
      key,
      resolve(rootPath, basename),
    ])) as Record<keyof typeof basenames, string>;
    expect(validateRecoveryPathObservation({
      rootPath,
      recoveryId: RECOVERY_ID,
      resolvedPaths: paths,
      componentsNoFollowSafe: true,
    })).toBe(true);
    expect(validateRecoveryPathObservation({
      rootPath,
      recoveryId: RECOVERY_ID,
      resolvedPaths: { ...paths, archive: resolve(rootPath, "..", "escape") },
      componentsNoFollowSafe: true,
    })).toBe(false);
    expect(validateRecoveryPathObservation({
      rootPath,
      recoveryId: RECOVERY_ID,
      resolvedPaths: paths,
      componentsNoFollowSafe: false,
    })).toBe(false);
  });
});
