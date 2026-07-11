import {
  classifyMeetingRecord,
  type ClassifiedMeetingRecord,
  type LibraryDocument,
  type LibraryPlacement,
  type LibraryVersion,
} from "@/domain/library";
import {
  createLibraryRepository,
  scanMeetingRecordObservations,
  type LibraryRepository,
  type LibraryRepositoryOptions,
} from "@/lib/library";
import { buildLibraryPublicView, type PublicLibraryView } from "@/lib/libraryQuery";
import { createLibraryRecoveryExecutor } from "@/lib/libraryRecoveryExecutor";
import { startMeetingCleanupSweep } from "@/lib/meetingCleanup";
import { dataRoot as defaultDataRoot } from "@/lib/paths";
import { deriveStatus, updateStatus } from "@/lib/status";

export type PublicLibraryMode = "ready" | "degraded_last_good" | "degraded_fallback";

export interface ResolvedLibraryState {
  mode: PublicLibraryMode;
  degradedReason?:
    | "corrupt"
    | "unsupported_version"
    | "io_error"
    | "recovery_conflict"
    | "recovery_not_supported";
  version: LibraryVersion | null;
  document: LibraryDocument | null;
  library: PublicLibraryView | null;
  records: ClassifiedMeetingRecord[];
  placements: LibraryPlacement[];
  repository: LibraryRepository;
  recovery?: { canRebuild: true; fingerprint: string };
}

export interface PublicLibraryResponse {
  mode: PublicLibraryMode;
  version: LibraryVersion | null;
  library: PublicLibraryView | null;
  degradedReason?: ResolvedLibraryState["degradedReason"];
  recovery?: ResolvedLibraryState["recovery"];
}

function repositoryOptions(dataRoot: string): LibraryRepositoryOptions {
  return { dataRoot };
}

function classifyWithPlacements(
  observations: Awaited<ReturnType<typeof scanMeetingRecordObservations>>,
  placements: readonly LibraryPlacement[],
): ClassifiedMeetingRecord[] {
  const placementIds = new Set(placements.map((placement) => placement.meetingId));
  return observations.map((observation) => classifyMeetingRecord({
    ...observation,
    hasPlacement: observation.meetingId !== undefined && placementIds.has(observation.meetingId),
  }));
}

async function deriveAndPersistRecordStatuses(
  records: readonly ClassifiedMeetingRecord[],
): Promise<ClassifiedMeetingRecord[]> {
  const updates: Array<Promise<unknown>> = [];
  const derived = records.map((record) => {
    if (record.kind !== "live" || record.meetingId === null || record.status === null) {
      return record;
    }
    const result = deriveStatus(record.meetingId, record.status);
    if (!result.changed) return record;
    updates.push(updateStatus(record.meetingId, undefined, (latest) => (
      deriveStatus(record.meetingId as string, latest).status
    )).catch(() => undefined));
    return { ...record, status: result.status };
  });
  // The derived view is immediately authoritative for this response. Queue
  // persistence without awaiting it: library reads are also used while a
  // finalize/delete meeting operation is held, and waiting for a nested status
  // operation there would invert the global lock order. The status queue runs
  // after that owner releases; a racing delete or failure is retried on the next
  // bounded library read.
  void Promise.allSettled(updates);
  return derived;
}

export async function readResolvedLibraryState(
  root = defaultDataRoot(),
): Promise<ResolvedLibraryState> {
  void startMeetingCleanupSweep(root).catch(() => {});
  let recoveryBlocksBootstrap = false;
  let recoveryFailure: "recovery_conflict" | "recovery_not_supported" | "io_error" | null = null;
  try {
    const recovery = await createLibraryRecoveryExecutor({ dataRoot: root }).resume();
    recoveryBlocksBootstrap = recovery.state === "recovery_conflict"
      || recovery.state === "recovery_io"
      || recovery.state === "recovery_not_supported";
    if (recovery.state === "recovery_conflict") recoveryFailure = "recovery_conflict";
    else if (recovery.state === "recovery_not_supported") recoveryFailure = "recovery_not_supported";
    else if (recovery.state === "recovery_io") recoveryFailure = "io_error";
  } catch {
    recoveryBlocksBootstrap = true;
    recoveryFailure = "io_error";
  }
  const repository = createLibraryRepository(repositoryOptions(root));
  let read = await repository.read();
  if (read.mode === "missing" && !recoveryBlocksBootstrap) read = await repository.bootstrap();
  if (read.mode === "ready") {
    const view = await repository.readView();
    if (view.read.mode === "ready" && view.scan) {
      const records = await deriveAndPersistRecordStatuses(view.scan.records);
      return {
        mode: "ready",
        version: view.read.version,
        document: view.read.document,
        library: buildLibraryPublicView(
          view.read.document,
          records,
          view.effectivePlacements,
        ),
        records,
        placements: view.effectivePlacements,
        repository,
      };
    }
    read = view.read;
  }

  const degradedReason = recoveryFailure ?? (read.mode === "corrupt"
    || read.mode === "unsupported_version"
    || read.mode === "io_error"
    ? read.mode
    : "io_error");
  const recovery = read.mode === "corrupt" && recoveryFailure === null
    ? { canRebuild: true as const, fingerprint: read.fingerprint }
    : undefined;
  const lastGood = repository.getLastGood();
  const placements = lastGood?.placements.map((placement) => ({ ...placement })) ?? [];
  let records: ClassifiedMeetingRecord[] = [];
  try {
    records = classifyWithPlacements(await scanMeetingRecordObservations(root), placements);
    records = await deriveAndPersistRecordStatuses(records);
  } catch {
    records = [];
  }
  if (lastGood) {
    const presentIds = new Set(records
      .filter((record) => record.preservePlacement && record.meetingId !== null)
      .map((record) => record.meetingId as string));
    const effectivePlacements = placements.filter((placement) => presentIds.has(placement.meetingId));
    return {
      mode: "degraded_last_good",
      degradedReason,
      version: null,
      document: lastGood,
      library: buildLibraryPublicView(lastGood, records, effectivePlacements),
      records,
      placements: effectivePlacements,
      repository,
      ...(recovery ? { recovery } : {}),
    };
  }
  return {
    mode: "degraded_fallback",
    degradedReason,
    version: null,
    document: null,
    library: null,
    records,
    placements: [],
    repository,
    ...(recovery ? { recovery } : {}),
  };
}

export function toPublicLibraryResponse(state: ResolvedLibraryState): PublicLibraryResponse {
  return {
    mode: state.mode,
    version: state.version,
    library: state.library,
    ...(state.degradedReason ? { degradedReason: state.degradedReason } : {}),
    ...(state.recovery ? { recovery: state.recovery } : {}),
  };
}
