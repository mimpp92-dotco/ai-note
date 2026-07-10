import {
  safeParseRecoveryIntent,
  type LibraryRecoveryIntent,
} from "@/domain/libraryRecoveryIntent";

type MissingObservation = { state: "missing" };
type InvalidObservation = { state: "invalid" };

export type RecoveryCanonicalObservation =
  | MissingObservation
  | InvalidObservation
  | {
      state: "file";
      sha256: string;
      documentValid: boolean;
      libraryId: string | null;
    };

export type RecoveryDocumentArtifactObservation =
  | MissingObservation
  | InvalidObservation
  | {
      state: "file";
      sha256: string;
      documentValid: boolean;
      libraryId: string | null;
    };

export type RecoveryHashArtifactObservation =
  | MissingObservation
  | InvalidObservation
  | { state: "file"; sha256: string };

export type RecoveryIntentObservation =
  | MissingObservation
  | InvalidObservation
  | { state: "multiple" }
  | { state: "valid"; value: LibraryRecoveryIntent };

export interface LibraryRecoveryObservation {
  recoveryId: string;
  pathSafety: "safe" | "unsafe";
  namespaceCapability: "supported" | "unsupported" | "unknown";
  intent: RecoveryIntentObservation;
  canonical: RecoveryCanonicalObservation;
  newTemp: RecoveryDocumentArtifactObservation;
  archive: RecoveryHashArtifactObservation;
  restoreTemp: RecoveryHashArtifactObservation;
  historicalArchives: Array<{ recoveryId: string; sha256: string }>;
}

export type LibraryRecoveryAction =
  | "no_op"
  | "cleanup_uncommitted"
  | "continue_archive"
  | "continue_publish"
  | "continue_restore"
  | "cleanup_committed"
  | "abort_to_corrupt"
  | "recovery_conflict"
  | "recovery_not_supported";

export interface LibraryRecoveryPlan {
  action: LibraryRecoveryAction;
  mutationAllowed: boolean;
  nextPhase: LibraryRecoveryIntent["phase"] | null;
  resultingMode: "ready" | "corrupt" | "missing" | null;
  reason: string;
  preconditions: {
    recoveryId: string;
    oldCanonicalSha256: string | null;
    newDocumentSha256: string | null;
    newLibraryId: string | null;
    pathSafety: "safe";
    namespaceDurabilityRequired: boolean;
  };
}

function basePreconditions(
  observation: LibraryRecoveryObservation,
  intent: LibraryRecoveryIntent | null,
): LibraryRecoveryPlan["preconditions"] {
  return {
    recoveryId: observation.recoveryId,
    oldCanonicalSha256: intent?.oldCanonicalSha256 ?? null,
    newDocumentSha256: intent?.newDocumentSha256 ?? null,
    newLibraryId: intent?.newLibraryId ?? null,
    pathSafety: "safe",
    namespaceDurabilityRequired: false,
  };
}

function plan(
  observation: LibraryRecoveryObservation,
  intent: LibraryRecoveryIntent | null,
  input: Omit<LibraryRecoveryPlan, "preconditions">,
): LibraryRecoveryPlan {
  return {
    ...input,
    preconditions: {
      ...basePreconditions(observation, intent),
      namespaceDurabilityRequired: input.mutationAllowed,
    },
  };
}

function conflict(
  observation: LibraryRecoveryObservation,
  intent: LibraryRecoveryIntent | null,
  reason: string,
): LibraryRecoveryPlan {
  return plan(observation, intent, {
    action: "recovery_conflict",
    mutationAllowed: false,
    nextPhase: null,
    resultingMode: null,
    reason,
  });
}

function mutation(
  observation: LibraryRecoveryObservation,
  intent: LibraryRecoveryIntent | null,
  input: Omit<LibraryRecoveryPlan, "preconditions" | "mutationAllowed">,
): LibraryRecoveryPlan {
  if (observation.namespaceCapability !== "supported") {
    return plan(observation, intent, {
      action: "recovery_not_supported",
      mutationAllowed: false,
      nextPhase: null,
      resultingMode: null,
      reason: "namespace_durability_not_supported",
    });
  }
  return plan(observation, intent, { ...input, mutationAllowed: true });
}

function present(observation: { state: string }): boolean {
  return observation.state !== "missing";
}

export function planLibraryRecovery(
  observation: LibraryRecoveryObservation,
): LibraryRecoveryPlan {
  if (observation.pathSafety !== "safe") {
    return conflict(observation, null, "unsafe_recovery_path");
  }
  if (observation.intent.state === "invalid" || observation.intent.state === "multiple") {
    return conflict(observation, null, "invalid_or_multiple_intent");
  }

  if (observation.intent.state === "missing") {
    const activeTemp = present(observation.newTemp) || present(observation.restoreTemp);
    if (observation.canonical.state === "missing" && (
      activeTemp || present(observation.archive)
    )) {
      return conflict(observation, null, "canonical_missing_with_active_artifact");
    }
    if (observation.canonical.state === "invalid") {
      return conflict(observation, null, "canonical_observation_invalid");
    }
    if (observation.canonical.state === "file" && activeTemp) {
      return mutation(observation, null, {
        action: "cleanup_uncommitted",
        nextPhase: null,
        resultingMode: observation.canonical.documentValid ? "ready" : "corrupt",
        reason: "orphan_temp_with_canonical",
      });
    }
    return plan(observation, null, {
      action: "no_op",
      mutationAllowed: false,
      nextPhase: null,
      resultingMode: observation.canonical.state === "missing"
        ? "missing"
        : observation.canonical.documentValid ? "ready" : "corrupt",
      reason: "no_active_recovery",
    });
  }

  const intentResult = safeParseRecoveryIntent(observation.intent.value);
  if (!intentResult.success || intentResult.data.recoveryId !== observation.recoveryId) {
    return conflict(observation, null, "intent_identity_mismatch");
  }
  const intent = intentResult.data;

  if (observation.canonical.state === "invalid") {
    return conflict(observation, intent, "canonical_observation_invalid");
  }
  if (observation.archive.state === "invalid") {
    return conflict(observation, intent, "archive_invalid");
  }
  if (observation.archive.state === "file" && observation.archive.sha256 !== intent.oldCanonicalSha256) {
    return conflict(observation, intent, "archive_hash_mismatch");
  }
  if (observation.restoreTemp.state === "invalid") {
    return conflict(observation, intent, "restore_temp_invalid");
  }
  if (
    observation.restoreTemp.state === "file"
    && observation.restoreTemp.sha256 !== intent.oldCanonicalSha256
  ) {
    return conflict(observation, intent, "restore_hash_mismatch");
  }
  if (observation.newTemp.state === "file" && (
    observation.newTemp.sha256 !== intent.newDocumentSha256
    || !observation.newTemp.documentValid
    || observation.newTemp.libraryId !== intent.newLibraryId
  )) {
    return conflict(observation, intent, "new_temp_identity_mismatch");
  }

  const archiveValid = observation.archive.state === "file";
  const newTempValid = observation.newTemp.state === "file";
  const restoreValid = observation.restoreTemp.state === "file";
  const restorePhase = intent.phase === "restore_prepared"
    || intent.phase === "restore_published"
    || intent.phase === "restore_verified";
  if ((restorePhase || intent.phase === "aborted") && newTempValid) {
    return conflict(observation, intent, "phase_contradicts_new_temp");
  }

  if (observation.canonical.state === "file") {
    const canonicalIsOld = observation.canonical.sha256 === intent.oldCanonicalSha256;
    const canonicalIsNew = observation.canonical.sha256 === intent.newDocumentSha256
      && observation.canonical.documentValid
      && observation.canonical.libraryId === intent.newLibraryId;
    if (!canonicalIsOld && !canonicalIsNew) {
      return conflict(observation, intent, "canonical_identity_mismatch");
    }
    if (canonicalIsNew) {
      if (!archiveValid) return conflict(observation, intent, "published_without_archive");
      return mutation(observation, intent, {
        action: "cleanup_committed",
        nextPhase: "publish_published",
        resultingMode: "ready",
        reason: "new_canonical_verified_cleanup_pending",
      });
    }

    if (intent.phase === "publish_published") {
      return conflict(observation, intent, "published_phase_with_old_canonical");
    }

    if (intent.phase === "restore_published" || intent.phase === "restore_verified") {
      if (!archiveValid) return conflict(observation, intent, "restored_without_archive");
      return mutation(observation, intent, {
        action: "cleanup_committed",
        nextPhase: "restore_verified",
        resultingMode: "corrupt",
        reason: "restored_old_canonical_verified",
      });
    }
    if (newTempValid) {
      return mutation(observation, intent, {
        action: archiveValid ? "continue_publish" : "continue_archive",
        nextPhase: archiveValid ? "publish_published" : "archive_published",
        resultingMode: null,
        reason: archiveValid ? "archive_verified_publish_new" : "archive_old_before_publish",
      });
    }
    if (observation.newTemp.state === "invalid" || observation.newTemp.state === "missing") {
      return mutation(observation, intent, {
        action: "abort_to_corrupt",
        nextPhase: "aborted",
        resultingMode: "corrupt",
        reason: "old_canonical_preserved_new_unusable",
      });
    }
  }

  if (observation.canonical.state === "missing") {
    if (!archiveValid) return conflict(observation, intent, "canonical_missing_without_archive");
    if (newTempValid) {
      return mutation(observation, intent, {
        action: "continue_publish",
        nextPhase: "publish_published",
        resultingMode: null,
        reason: "archive_verified_publish_after_missing_canonical",
      });
    }
    if (restoreValid) {
      return mutation(observation, intent, {
        action: "continue_restore",
        nextPhase: "restore_published",
        resultingMode: null,
        reason: "restore_temp_verified_publish_old",
      });
    }
    return mutation(observation, intent, {
      action: "continue_restore",
      nextPhase: "restore_prepared",
      resultingMode: null,
      reason: "copy_archive_to_restore_temp",
    });
  }

  return conflict(observation, intent, "unhandled_recovery_state");
}
