import { describe, expect, it } from "vitest";

import type { LibraryRecoveryIntent } from "@/domain/libraryRecoveryIntent";
import {
  planLibraryRecovery,
  type LibraryRecoveryObservation,
} from "@/domain/libraryRecoveryPlanner";

const RECOVERY_ID = "10000000-0000-4000-8000-000000000001";
const LIBRARY_ID = "20000000-0000-4000-8000-000000000002";
const OLD_HASH = "a".repeat(64);
const NEW_HASH = "b".repeat(64);

function intent(phase: LibraryRecoveryIntent["phase"] = "intent_created"): LibraryRecoveryIntent {
  return {
    schemaVersion: 1,
    recoveryId: RECOVERY_ID,
    oldCanonicalSha256: OLD_HASH,
    newLibraryId: LIBRARY_ID,
    newDocumentSha256: NEW_HASH,
    phase,
  };
}

const missing = { state: "missing" as const };
const oldCanonical = { state: "file" as const, sha256: OLD_HASH, documentValid: false, libraryId: null };
const newCanonical = { state: "file" as const, sha256: NEW_HASH, documentValid: true, libraryId: LIBRARY_ID };
const validNewTemp = { state: "file" as const, sha256: NEW_HASH, documentValid: true, libraryId: LIBRARY_ID };
const validArchive = { state: "file" as const, sha256: OLD_HASH };
const validRestore = { state: "file" as const, sha256: OLD_HASH };

function observation(overrides: Partial<LibraryRecoveryObservation> = {}): LibraryRecoveryObservation {
  return {
    recoveryId: RECOVERY_ID,
    pathSafety: "safe",
    namespaceCapability: "supported",
    intent: { state: "valid", value: intent() },
    canonical: oldCanonical,
    newTemp: validNewTemp,
    archive: missing,
    restoreTemp: missing,
    historicalArchives: [],
    ...overrides,
  };
}

describe("pure library recovery planner decision table", () => {
  it.each([
    [
      "archive old before publish",
      observation(),
      "continue_archive",
      "archive_published",
    ],
    [
      "publish after archive",
      observation({ archive: validArchive }),
      "continue_publish",
      "publish_published",
    ],
    [
      "published new and preserved archive",
      observation({ canonical: newCanonical, archive: validArchive, newTemp: missing }),
      "cleanup_committed",
      "publish_published",
    ],
    [
      "publish temp after canonical disappeared",
      observation({ canonical: missing, archive: validArchive }),
      "continue_publish",
      "publish_published",
    ],
    [
      "prepare restore when publish source vanished",
      observation({ canonical: missing, archive: validArchive, newTemp: missing }),
      "continue_restore",
      "restore_prepared",
    ],
    [
      "finish prepared restore",
      observation({ canonical: missing, archive: validArchive, newTemp: missing, restoreTemp: validRestore, intent: { state: "valid", value: intent("restore_prepared") } }),
      "continue_restore",
      "restore_published",
    ],
    [
      "verify restored old canonical and cleanup",
      observation({ canonical: oldCanonical, archive: validArchive, newTemp: missing, restoreTemp: missing, intent: { state: "valid", value: intent("restore_published") } }),
      "cleanup_committed",
      "restore_verified",
    ],
    [
      "abort while old canonical is still safe and new temp is missing",
      observation({ newTemp: missing }),
      "abort_to_corrupt",
      "aborted",
    ],
  ] as const)("plans %s deterministically", (_label, input, action, nextPhase) => {
    const first = planLibraryRecovery(input);
    const second = planLibraryRecovery(structuredClone(input));
    expect(first).toEqual(second);
    expect(first).toMatchObject({ action, nextPhase, mutationAllowed: true });
    expect(first.preconditions.recoveryId).toBe(RECOVERY_ID);
  });

  it("cleans an orphan temp only when canonical exists and no active intent exists", () => {
    expect(planLibraryRecovery(observation({
      intent: { state: "missing" },
      canonical: oldCanonical,
      archive: missing,
    }))).toMatchObject({ action: "cleanup_uncommitted", mutationAllowed: true });
    expect(planLibraryRecovery(observation({
      intent: { state: "missing" },
      canonical: missing,
      archive: missing,
    }))).toMatchObject({ action: "recovery_conflict", mutationAllowed: false });
  });

  it("ignores historical completed archives when no active artifacts exist", () => {
    expect(planLibraryRecovery(observation({
      intent: { state: "missing" },
      canonical: newCanonical,
      newTemp: missing,
      archive: missing,
      historicalArchives: [{ recoveryId: "30000000-0000-4000-8000-000000000003", sha256: OLD_HASH }],
    }))).toMatchObject({ action: "no_op", mutationAllowed: false, resultingMode: "ready" });
  });

  it.each([
    observation({ pathSafety: "unsafe" }),
    observation({ intent: { state: "invalid" } }),
    observation({ intent: { state: "multiple" } }),
    observation({ canonical: { ...newCanonical, sha256: "c".repeat(64) }, archive: validArchive }),
    observation({ canonical: newCanonical, archive: missing }),
    observation({ canonical: missing, archive: { state: "file", sha256: "c".repeat(64) } }),
    observation({ newTemp: { ...validNewTemp, libraryId: "30000000-0000-4000-8000-000000000003" } }),
  ])("fails closed for unsafe, contradictory, mismatched, or preservation-missing state", (input) => {
    expect(planLibraryRecovery(input)).toMatchObject({
      action: "recovery_conflict",
      mutationAllowed: false,
    });
  });

  it("reports recovery_not_supported before returning any mutation plan", () => {
    expect(planLibraryRecovery(observation({ namespaceCapability: "unsupported" }))).toMatchObject({
      action: "recovery_not_supported",
      mutationAllowed: false,
    });
  });

  it("rejects an explicit phase that contradicts the observed publication direction", () => {
    expect(planLibraryRecovery(observation({
      intent: { state: "valid", value: intent("publish_published") },
      canonical: oldCanonical,
      archive: missing,
      newTemp: validNewTemp,
    }))).toMatchObject({ action: "recovery_conflict", mutationAllowed: false });
    expect(planLibraryRecovery(observation({
      intent: { state: "valid", value: intent("restore_prepared") },
      canonical: oldCanonical,
      archive: validArchive,
      newTemp: validNewTemp,
    }))).toMatchObject({ action: "recovery_conflict", mutationAllowed: false });
  });

  it("never turns canonical-missing ambiguous active artifacts into bootstrap or cleanup", () => {
    const plan = planLibraryRecovery(observation({
      canonical: missing,
      intent: { state: "invalid" },
      newTemp: { state: "invalid" },
      archive: missing,
    }));
    expect(plan.action).toBe("recovery_conflict");
    expect(JSON.stringify(plan)).not.toMatch(/bootstrap|cleanup_uncommitted/);
  });

  it("is total and deterministic over the bounded observation product", () => {
    const canonicals: LibraryRecoveryObservation["canonical"][] = [
      missing,
      { state: "invalid" },
      oldCanonical,
      newCanonical,
      { ...newCanonical, sha256: "c".repeat(64) },
    ];
    const intents: LibraryRecoveryObservation["intent"][] = [
      { state: "missing" },
      { state: "invalid" },
      { state: "multiple" },
      { state: "valid", value: intent() },
    ];
    const documents: LibraryRecoveryObservation["newTemp"][] = [
      missing,
      { state: "invalid" },
      validNewTemp,
      { ...validNewTemp, sha256: "c".repeat(64) },
    ];
    const hashes: LibraryRecoveryObservation["archive"][] = [
      missing,
      { state: "invalid" },
      validArchive,
      { state: "file", sha256: "c".repeat(64) },
    ];
    let cases = 0;
    for (const canonical of canonicals) {
      for (const intentState of intents) {
        for (const newTemp of documents) {
          for (const archive of hashes) {
            for (const restoreTemp of hashes) {
              const input = observation({ canonical, intent: intentState, newTemp, archive, restoreTemp });
              const first = planLibraryRecovery(input);
              expect(first).toEqual(planLibraryRecovery(structuredClone(input)));
              expect([
                "no_op",
                "cleanup_uncommitted",
                "continue_archive",
                "continue_publish",
                "continue_restore",
                "cleanup_committed",
                "abort_to_corrupt",
                "recovery_conflict",
                "recovery_not_supported",
              ]).toContain(first.action);
              if (intentState.state === "invalid" || intentState.state === "multiple") {
                expect(first.mutationAllowed).toBe(false);
              }
              cases += 1;
            }
          }
        }
      }
    }
    expect(cases).toBe(1_280);
  });
});
