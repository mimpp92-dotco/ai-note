import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  readdir,
  rmdir,
} from "node:fs/promises";
import {
  dirname,
  join,
  relative,
  resolve,
} from "node:path";

import {
  classifyMeetingRecord,
  parseLibraryDocument,
  safeParseLibraryDocument,
  type LibraryDocument,
  type LibraryVersion,
} from "@/domain/library";
import {
  deriveRecoveryBasenames,
  parseRecoveryIntentText,
  validateRecoveryPathObservation,
  type LibraryRecoveryIntent,
  type RecoveryBasenames,
} from "@/domain/libraryRecoveryIntent";
import {
  planLibraryRecovery,
  type LibraryRecoveryObservation,
  type LibraryRecoveryPlan,
  type RecoveryCanonicalObservation,
  type RecoveryDocumentArtifactObservation,
  type RecoveryHashArtifactObservation,
  type RecoveryIntentObservation,
} from "@/domain/libraryRecoveryPlanner";
import {
  createDirectorySyncCapability,
  createNodeFileOps,
  durableAtomicReplace,
  syncNamespaces,
  type DirectorySyncCapability,
  type FileOps,
} from "@/lib/durableFileOps";
import {
  runInLibraryQueue,
  scanMeetingRecordObservations,
} from "@/lib/library";
import { getStatusUpdater } from "@/lib/statusUpdater";

const PLACEHOLDER_RECOVERY_ID = "00000000-0000-4000-8000-000000000000";
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID_PART = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const RECOVERY_FILE_PATTERNS = {
  intent: new RegExp(`^\\.library-recovery-(${UUID_PART})\\.intent\\.json$`, "u"),
  newTemp: new RegExp(`^\\.library-recovery-(${UUID_PART})\\.new\\.json$`, "u"),
  archive: new RegExp(`^library\\.archive-(${UUID_PART})\\.json$`, "u"),
  restoreTemp: new RegExp(`^\\.library-recovery-(${UUID_PART})\\.restore\\.json$`, "u"),
} as const;

type CanonicalMode = "missing" | "ready" | "corrupt" | "unsupported_version";

export type LibraryRecoveryResult =
  | {
      state: "ready";
      version: LibraryVersion;
      discoveredVisibleMeetingCount: number;
      organizationReset: boolean;
      archivePreserved: boolean;
    }
  | { state: "corrupt"; fingerprint: string }
  | { state: "missing" }
  | { state: "unsupported_version" }
  | {
      state: "fingerprint_changed";
      currentMode: CanonicalMode;
      fingerprint?: string;
    }
  | { state: "recovery_not_supported" }
  | { state: "recovery_conflict" }
  | { state: "recovery_io" };

export interface LibraryRecoveryExecutorOptions {
  dataRoot: string;
  fileOps?: FileOps;
  capability?: DirectorySyncCapability;
  idFactory?: () => string;
  now?: () => string;
}

export interface LibraryRecoveryExecutor {
  rebuild(input: { fingerprint: string }): Promise<LibraryRecoveryResult>;
  resume(): Promise<LibraryRecoveryResult>;
}

class RecoveryOperationError extends Error {
  readonly kind: "conflict" | "io" | "not_supported";

  constructor(kind: RecoveryOperationError["kind"]) {
    super(kind);
    this.name = "RecoveryOperationError";
    this.kind = kind;
  }
}

interface CanonicalSnapshot {
  observation: RecoveryCanonicalObservation;
  mode: CanonicalMode;
  fingerprint: string | null;
  document: LibraryDocument | null;
  unsafe: boolean;
}

interface RecoveryPaths extends Record<keyof RecoveryBasenames, string> {
  directory: string;
  canonical: string;
}

interface CollectedRecoveryState {
  observation: LibraryRecoveryObservation;
  canonical: CanonicalSnapshot;
  paths: RecoveryPaths;
  intent: LibraryRecoveryIntent | null;
  hasActiveRecovery: boolean;
}

interface InternalRecoveryResult {
  state: LibraryRecoveryResult["state"];
  canonicalMode?: CanonicalMode;
  fingerprint?: string;
  document?: LibraryDocument;
  archivePreserved?: boolean;
  discoveredVisibleMeetingCount?: number;
  organizationReset?: boolean;
}

interface ReadFileObservation {
  state: "missing" | "file" | "unsafe";
  bytes?: Uint8Array;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function hash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function serializeDocument(document: LibraryDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function serializeIntent(intent: LibraryRecoveryIntent): string {
  return `${JSON.stringify(intent, null, 2)}\n`;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"));
}

function versionOf(document: LibraryDocument): LibraryVersion {
  return { libraryId: document.libraryId, revision: document.revision };
}

function resultForError(error: unknown): InternalRecoveryResult {
  if (error instanceof RecoveryOperationError) {
    if (error.kind === "conflict") return { state: "recovery_conflict" };
    if (error.kind === "not_supported") return { state: "recovery_not_supported" };
  }
  return { state: "recovery_io" };
}

async function setPrivateMode(path: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(path, mode);
  } catch {
    throw new RecoveryOperationError("io");
  }
}

async function readRegularFile(path: string, fileOps: FileOps): Promise<ReadFileObservation> {
  let info;
  try {
    info = await fileOps.lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { state: "missing" };
    throw new RecoveryOperationError("io");
  }
  if (info.isSymbolicLink() || !info.isFile()) return { state: "unsafe" };

  let handle: Awaited<ReturnType<FileOps["openFile"]>> | null = null;
  try {
    handle = await fileOps.openFile(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    return { state: "file", bytes: await handle.readFile() };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { state: "missing" };
    if (isErrno(error, "ELOOP")) return { state: "unsafe" };
    throw new RecoveryOperationError("io");
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function parseCanonical(bytes: Uint8Array): Omit<CanonicalSnapshot, "unsafe"> {
  const fileFingerprint = hash(bytes);
  let candidate: unknown;
  try {
    candidate = JSON.parse(decode(bytes)) as unknown;
  } catch {
    return {
      observation: {
        state: "file",
        sha256: fileFingerprint,
        documentValid: false,
        libraryId: null,
      },
      mode: "corrupt",
      fingerprint: fileFingerprint,
      document: null,
    };
  }
  if (
    typeof candidate === "object"
    && candidate !== null
    && "schemaVersion" in candidate
    && typeof (candidate as { schemaVersion?: unknown }).schemaVersion === "number"
    && (candidate as { schemaVersion: number }).schemaVersion > 1
  ) {
    return {
      observation: {
        state: "file",
        sha256: fileFingerprint,
        documentValid: false,
        libraryId: null,
      },
      mode: "unsupported_version",
      fingerprint: fileFingerprint,
      document: null,
    };
  }
  const parsed = safeParseLibraryDocument(candidate);
  if (!parsed.success) {
    return {
      observation: {
        state: "file",
        sha256: fileFingerprint,
        documentValid: false,
        libraryId: null,
      },
      mode: "corrupt",
      fingerprint: fileFingerprint,
      document: null,
    };
  }
  return {
    observation: {
      state: "file",
      sha256: fileFingerprint,
      documentValid: true,
      libraryId: parsed.data.libraryId,
    },
    mode: "ready",
    fingerprint: fileFingerprint,
    document: parsed.data,
  };
}

async function observeCanonical(path: string, fileOps: FileOps): Promise<CanonicalSnapshot> {
  const observed = await readRegularFile(path, fileOps);
  if (observed.state === "missing") {
    return {
      observation: { state: "missing" },
      mode: "missing",
      fingerprint: null,
      document: null,
      unsafe: false,
    };
  }
  if (observed.state === "unsafe" || !observed.bytes) {
    return {
      observation: { state: "invalid" },
      mode: "corrupt",
      fingerprint: null,
      document: null,
      unsafe: true,
    };
  }
  return { ...parseCanonical(observed.bytes), unsafe: false };
}

async function inspectRecoveryRoot(
  dataRoot: string,
  recoveryDirectory: string,
  fileOps: FileOps,
): Promise<{ safe: boolean; recoveryExists: boolean }> {
  let rootInfo;
  try {
    rootInfo = await fileOps.lstat(dataRoot);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { safe: true, recoveryExists: false };
    throw new RecoveryOperationError("io");
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    return { safe: false, recoveryExists: false };
  }

  let rootReal: string;
  try {
    rootReal = await fileOps.realpath(dataRoot);
  } catch {
    throw new RecoveryOperationError("io");
  }
  let recoveryInfo;
  try {
    recoveryInfo = await fileOps.lstat(recoveryDirectory);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { safe: true, recoveryExists: false };
    throw new RecoveryOperationError("io");
  }
  if (!recoveryInfo.isDirectory() || recoveryInfo.isSymbolicLink()) {
    return { safe: false, recoveryExists: true };
  }
  try {
    const recoveryReal = await fileOps.realpath(recoveryDirectory);
    return { safe: contained(rootReal, recoveryReal), recoveryExists: true };
  } catch {
    throw new RecoveryOperationError("io");
  }
}

function artifactMatch(name: string): { kind: keyof RecoveryBasenames; recoveryId: string } | null {
  for (const kind of Object.keys(RECOVERY_FILE_PATTERNS) as Array<keyof RecoveryBasenames>) {
    const match = RECOVERY_FILE_PATTERNS[kind].exec(name);
    if (match) return { kind, recoveryId: match[1] };
  }
  return null;
}

function recoveryPaths(dataRoot: string, recoveryId: string): RecoveryPaths {
  const directory = join(dataRoot, "library-recovery");
  const names = deriveRecoveryBasenames(recoveryId);
  return {
    directory,
    canonical: join(dataRoot, "library.json"),
    intent: join(directory, names.intent),
    newTemp: join(directory, names.newTemp),
    archive: join(directory, names.archive),
    restoreTemp: join(directory, names.restoreTemp),
  };
}

async function observeDocumentArtifact(
  path: string,
  fileOps: FileOps,
): Promise<{ observation: RecoveryDocumentArtifactObservation; unsafe: boolean }> {
  const observed = await readRegularFile(path, fileOps);
  if (observed.state === "missing") return { observation: { state: "missing" }, unsafe: false };
  if (observed.state === "unsafe" || !observed.bytes) {
    return { observation: { state: "invalid" }, unsafe: true };
  }
  const artifactHash = hash(observed.bytes);
  try {
    const candidate = JSON.parse(decode(observed.bytes)) as unknown;
    const parsed = safeParseLibraryDocument(candidate);
    return {
      observation: {
        state: "file",
        sha256: artifactHash,
        documentValid: parsed.success,
        libraryId: parsed.success ? parsed.data.libraryId : null,
      },
      unsafe: false,
    };
  } catch {
    return {
      observation: {
        state: "file",
        sha256: artifactHash,
        documentValid: false,
        libraryId: null,
      },
      unsafe: false,
    };
  }
}

async function observeHashArtifact(
  path: string,
  fileOps: FileOps,
): Promise<{ observation: RecoveryHashArtifactObservation; unsafe: boolean }> {
  const observed = await readRegularFile(path, fileOps);
  if (observed.state === "missing") return { observation: { state: "missing" }, unsafe: false };
  if (observed.state === "unsafe" || !observed.bytes) {
    return { observation: { state: "invalid" }, unsafe: true };
  }
  return {
    observation: { state: "file", sha256: hash(observed.bytes) },
    unsafe: false,
  };
}

async function collectRecoveryState(input: {
  dataRoot: string;
  fileOps: FileOps;
  capability: DirectorySyncCapability;
}): Promise<CollectedRecoveryState> {
  const directory = join(input.dataRoot, "library-recovery");
  const root = await inspectRecoveryRoot(input.dataRoot, directory, input.fileOps);
  const canonical = await observeCanonical(join(input.dataRoot, "library.json"), input.fileOps);
  let entryNames: string[] = [];
  if (root.recoveryExists && root.safe) {
    try {
      entryNames = await readdir(directory);
    } catch {
      throw new RecoveryOperationError("io");
    }
  }

  const artifacts = entryNames.map((name) => ({ name, match: artifactMatch(name) }));
  const malformed = artifacts.some((artifact) => artifact.match === null);
  const intents = artifacts.filter((artifact) => artifact.match?.kind === "intent");
  const activeIds = new Set<string>();
  for (const artifact of artifacts) {
    if (
      artifact.match?.kind === "intent"
      || artifact.match?.kind === "newTemp"
      || artifact.match?.kind === "restoreTemp"
    ) activeIds.add(artifact.match.recoveryId);
  }
  if (canonical.mode === "missing" && activeIds.size === 0) {
    for (const artifact of artifacts) {
      if (artifact.match?.kind === "archive") activeIds.add(artifact.match.recoveryId);
    }
  }
  const ambiguous = intents.length > 1 || activeIds.size > 1;
  const selectedId = activeIds.values().next().value as string | undefined;
  const recoveryId = selectedId ?? PLACEHOLDER_RECOVERY_ID;
  const paths = recoveryPaths(input.dataRoot, recoveryId);

  let unsafe = !root.safe || canonical.unsafe;
  let intentObservation: RecoveryIntentObservation = { state: "missing" };
  let intent: LibraryRecoveryIntent | null = null;
  if (ambiguous) {
    intentObservation = { state: "multiple" };
  } else if (malformed) {
    intentObservation = { state: "invalid" };
  } else if (intents.length === 1) {
    const observed = await readRegularFile(paths.intent, input.fileOps);
    if (observed.state === "unsafe") {
      unsafe = true;
      intentObservation = { state: "invalid" };
    } else if (observed.state === "missing" || !observed.bytes) {
      intentObservation = { state: "missing" };
    } else {
      try {
        intent = parseRecoveryIntentText(decode(observed.bytes));
        intentObservation = { state: "valid", value: intent };
      } catch {
        intentObservation = { state: "invalid" };
      }
    }
  }

  const newTemp = await observeDocumentArtifact(paths.newTemp, input.fileOps);
  const restoreTemp = await observeHashArtifact(paths.restoreTemp, input.fileOps);
  const archiveIsActive = selectedId !== undefined;
  const archive = archiveIsActive
    ? await observeHashArtifact(paths.archive, input.fileOps)
    : { observation: { state: "missing" } as const, unsafe: false };
  unsafe ||= newTemp.unsafe || restoreTemp.unsafe || archive.unsafe;

  const historicalArchives: Array<{ recoveryId: string; sha256: string }> = [];
  for (const artifact of artifacts) {
    if (artifact.match?.kind !== "archive" || artifact.match.recoveryId === selectedId) continue;
    const historicalPath = recoveryPaths(input.dataRoot, artifact.match.recoveryId).archive;
    const historical = await observeHashArtifact(historicalPath, input.fileOps);
    if (historical.unsafe || historical.observation.state !== "file") {
      unsafe = true;
      continue;
    }
    historicalArchives.push({
      recoveryId: artifact.match.recoveryId,
      sha256: historical.observation.sha256,
    });
  }

  const lexicalPaths = {
    intent: paths.intent,
    newTemp: paths.newTemp,
    archive: paths.archive,
    restoreTemp: paths.restoreTemp,
  };
  const pathSafety = validateRecoveryPathObservation({
    rootPath: directory,
    recoveryId,
    resolvedPaths: lexicalPaths,
    componentsNoFollowSafe: !unsafe,
  }) ? "safe" : "unsafe";

  return {
    observation: {
      recoveryId,
      pathSafety,
      namespaceCapability: input.capability.state,
      intent: intentObservation,
      canonical: canonical.observation,
      newTemp: newTemp.observation,
      archive: archive.observation,
      restoreTemp: restoreTemp.observation,
      historicalArchives,
    },
    canonical,
    paths,
    intent,
    hasActiveRecovery: selectedId !== undefined || intents.length > 0 || malformed,
  };
}

async function requireDurableNamespaces(
  directories: readonly string[],
  fileOps: FileOps,
  capability: DirectorySyncCapability,
): Promise<void> {
  if (capability.state === "unsupported") throw new RecoveryOperationError("not_supported");
  const result = await syncNamespaces(directories, { fileOps, capability });
  if (result.durability === "durable") return;
  if (result.durability === "best_effort") throw new RecoveryOperationError("not_supported");
  throw new RecoveryOperationError("io");
}

async function ensureRecoveryDirectory(input: {
  dataRoot: string;
  recoveryDirectory: string;
  fileOps: FileOps;
  capability: DirectorySyncCapability;
}): Promise<void> {
  let created = false;
  try {
    await input.fileOps.mkdir(input.recoveryDirectory, { recursive: false, mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw new RecoveryOperationError("io");
  }
  try {
    const safety = await inspectRecoveryRoot(input.dataRoot, input.recoveryDirectory, input.fileOps);
    if (!safety.safe || !safety.recoveryExists) throw new RecoveryOperationError("conflict");
    await setPrivateMode(input.recoveryDirectory, 0o700);
    await requireDurableNamespaces(
      [input.dataRoot, input.recoveryDirectory],
      input.fileOps,
      input.capability,
    );
  } catch (error) {
    if (created) await rmdir(input.recoveryDirectory).catch(() => {});
    throw error;
  }
}

async function writeExclusiveFile(input: {
  path: string;
  data: string | Uint8Array;
  fileOps: FileOps;
}): Promise<void> {
  let handle: Awaited<ReturnType<FileOps["openFile"]>> | null = null;
  try {
    handle = await input.fileOps.openFile(
      input.path,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(input.data);
    await handle.sync();
    await handle.close();
    handle = null;
    await setPrivateMode(input.path, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (isErrno(error, "EEXIST") || isErrno(error, "ELOOP")) {
      throw new RecoveryOperationError("conflict");
    }
    throw new RecoveryOperationError("io");
  }
}

async function rewriteIntentPhase(input: {
  intent: LibraryRecoveryIntent;
  phase: LibraryRecoveryIntent["phase"] | null;
  path: string;
  recoveryDirectory: string;
  fileOps: FileOps;
  capability: DirectorySyncCapability;
}): Promise<LibraryRecoveryIntent> {
  if (!input.phase || input.intent.phase === input.phase) return input.intent;
  const next = { ...input.intent, phase: input.phase };
  try {
    const observed = await readRegularFile(input.path, input.fileOps);
    if (observed.state !== "file" || !observed.bytes) {
      throw new RecoveryOperationError("conflict");
    }
    let current: LibraryRecoveryIntent;
    try {
      current = parseRecoveryIntentText(decode(observed.bytes));
    } catch {
      throw new RecoveryOperationError("conflict");
    }
    if (JSON.stringify(current) !== JSON.stringify(input.intent)) {
      throw new RecoveryOperationError("conflict");
    }
    const commit = await durableAtomicReplace({
      rootPath: input.recoveryDirectory,
      targetPath: input.path,
      data: serializeIntent(next),
      fileOps: input.fileOps,
      capability: input.capability,
      mode: 0o600,
    });
    if (commit.state === "not_committed") {
      throw new RecoveryOperationError(
        commit.errorCode === "unsafe_path" ? "conflict" : "io",
      );
    }
    if (commit.state === "committed_best_effort") {
      throw new RecoveryOperationError("not_supported");
    }
    if (commit.state === "committed_durability_pending") {
      // The rename is already authoritative. A fresh executor will observe the
      // complete next-phase intent and resume by planner state; never rewrite
      // the marker in place or roll the phase back.
      throw new RecoveryOperationError("io");
    }
    await setPrivateMode(input.path, 0o600);
    return next;
  } catch (error) {
    if (error instanceof RecoveryOperationError) throw error;
    throw new RecoveryOperationError("io");
  }
}

async function assertArtifactHash(
  path: string,
  expected: string,
  fileOps: FileOps,
): Promise<void> {
  const observed = await readRegularFile(path, fileOps);
  if (observed.state !== "file" || !observed.bytes || hash(observed.bytes) !== expected) {
    throw new RecoveryOperationError("conflict");
  }
}

async function assertMissing(path: string, fileOps: FileOps): Promise<void> {
  const observed = await readRegularFile(path, fileOps);
  if (observed.state !== "missing") throw new RecoveryOperationError("conflict");
}

async function unlinkIfPresent(path: string, fileOps: FileOps): Promise<boolean> {
  const observed = await readRegularFile(path, fileOps);
  if (observed.state === "missing") return false;
  if (observed.state !== "file") throw new RecoveryOperationError("conflict");
  try {
    await fileOps.unlink(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw new RecoveryOperationError("io");
  }
}

function samePlan(left: LibraryRecoveryPlan, right: LibraryRecoveryPlan): boolean {
  return left.action === right.action
    && JSON.stringify(left.preconditions) === JSON.stringify(right.preconditions);
}

async function executeMutation(input: {
  state: CollectedRecoveryState;
  plan: LibraryRecoveryPlan;
  fileOps: FileOps;
  capability: DirectorySyncCapability;
}): Promise<void> {
  const { state, plan, fileOps, capability } = input;
  const intent = state.intent;
  const oldHash = plan.preconditions.oldCanonicalSha256;
  const newHash = plan.preconditions.newDocumentSha256;

  if (plan.action === "cleanup_uncommitted") {
    await unlinkIfPresent(state.paths.newTemp, fileOps);
    await unlinkIfPresent(state.paths.restoreTemp, fileOps);
    await requireDurableNamespaces([state.paths.directory], fileOps, capability);
    return;
  }
  if (!intent || !oldHash || !newHash) throw new RecoveryOperationError("conflict");

  if (plan.action === "continue_archive") {
    await assertArtifactHash(state.paths.canonical, oldHash, fileOps);
    await assertArtifactHash(state.paths.newTemp, newHash, fileOps);
    await assertMissing(state.paths.archive, fileOps);
    try {
      await fileOps.rename(state.paths.canonical, state.paths.archive);
    } catch {
      throw new RecoveryOperationError("io");
    }
    await setPrivateMode(state.paths.archive, 0o600);
    await requireDurableNamespaces(
      [dirname(state.paths.canonical), dirname(state.paths.archive)],
      fileOps,
      capability,
    );
    await rewriteIntentPhase({
      intent,
      phase: plan.nextPhase,
      path: state.paths.intent,
      recoveryDirectory: state.paths.directory,
      fileOps,
      capability,
    });
    return;
  }

  if (plan.action === "continue_publish") {
    await assertArtifactHash(state.paths.archive, oldHash, fileOps);
    await assertArtifactHash(state.paths.newTemp, newHash, fileOps);
    if (state.canonical.mode !== "missing") {
      await assertArtifactHash(state.paths.canonical, oldHash, fileOps);
    }
    try {
      await fileOps.rename(state.paths.newTemp, state.paths.canonical);
    } catch {
      throw new RecoveryOperationError("io");
    }
    await setPrivateMode(state.paths.canonical, 0o600);
    await requireDurableNamespaces(
      [dirname(state.paths.newTemp), dirname(state.paths.canonical)],
      fileOps,
      capability,
    );
    await assertArtifactHash(state.paths.canonical, newHash, fileOps);
    await assertArtifactHash(state.paths.archive, oldHash, fileOps);
    await rewriteIntentPhase({
      intent,
      phase: plan.nextPhase,
      path: state.paths.intent,
      recoveryDirectory: state.paths.directory,
      fileOps,
      capability,
    });
    return;
  }

  if (plan.action === "continue_restore") {
    await assertArtifactHash(state.paths.archive, oldHash, fileOps);
    if (state.observation.restoreTemp.state === "missing") {
      await assertMissing(state.paths.restoreTemp, fileOps);
      try {
        await fileOps.copyFile(
          state.paths.archive,
          state.paths.restoreTemp,
          constants.COPYFILE_EXCL,
        );
      } catch {
        throw new RecoveryOperationError("io");
      }
      await setPrivateMode(state.paths.restoreTemp, 0o600);
      let handle: Awaited<ReturnType<FileOps["openFile"]>> | null = null;
      try {
        handle = await fileOps.openFile(
          state.paths.restoreTemp,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        await handle.sync();
      } catch {
        throw new RecoveryOperationError("io");
      } finally {
        if (handle) await handle.close().catch(() => {});
      }
      await requireDurableNamespaces([state.paths.directory], fileOps, capability);
      await assertArtifactHash(state.paths.restoreTemp, oldHash, fileOps);
      await rewriteIntentPhase({
        intent,
        phase: "restore_prepared",
        path: state.paths.intent,
        recoveryDirectory: state.paths.directory,
        fileOps,
        capability,
      });
      return;
    }

    await assertArtifactHash(state.paths.restoreTemp, oldHash, fileOps);
    await assertMissing(state.paths.canonical, fileOps);
    try {
      await fileOps.rename(state.paths.restoreTemp, state.paths.canonical);
    } catch {
      throw new RecoveryOperationError("io");
    }
    await setPrivateMode(state.paths.canonical, 0o600);
    await requireDurableNamespaces(
      [dirname(state.paths.restoreTemp), dirname(state.paths.canonical)],
      fileOps,
      capability,
    );
    await assertArtifactHash(state.paths.canonical, oldHash, fileOps);
    await rewriteIntentPhase({
      intent,
      phase: "restore_published",
      path: state.paths.intent,
      recoveryDirectory: state.paths.directory,
      fileOps,
      capability,
    });
    return;
  }

  if (plan.action === "cleanup_committed" || plan.action === "abort_to_corrupt") {
    if (plan.action === "cleanup_committed") {
      if (plan.resultingMode === "ready") {
        await assertArtifactHash(state.paths.canonical, newHash, fileOps);
      } else {
        await assertArtifactHash(state.paths.canonical, oldHash, fileOps);
      }
      await assertArtifactHash(state.paths.archive, oldHash, fileOps);
    } else {
      await assertArtifactHash(state.paths.canonical, oldHash, fileOps);
    }
    await rewriteIntentPhase({
      intent,
      phase: plan.action === "abort_to_corrupt" ? "aborted" : plan.nextPhase,
      path: state.paths.intent,
      recoveryDirectory: state.paths.directory,
      fileOps,
      capability,
    });
    await unlinkIfPresent(state.paths.newTemp, fileOps);
    await unlinkIfPresent(state.paths.restoreTemp, fileOps);
    await unlinkIfPresent(state.paths.intent, fileOps);
    await requireDurableNamespaces([state.paths.directory], fileOps, capability);
    return;
  }

  throw new RecoveryOperationError("conflict");
}

function finalInternalResult(state: CollectedRecoveryState): InternalRecoveryResult {
  if (state.canonical.mode === "ready" && state.canonical.document) {
    return {
      state: "ready",
      canonicalMode: "ready",
      fingerprint: state.canonical.fingerprint ?? undefined,
      document: state.canonical.document,
      archivePreserved: state.observation.historicalArchives.length > 0,
    };
  }
  if (state.canonical.mode === "corrupt") {
    return {
      state: "corrupt",
      canonicalMode: "corrupt",
      fingerprint: state.canonical.fingerprint ?? undefined,
    };
  }
  if (state.canonical.mode === "unsupported_version") {
    return { state: "unsupported_version", canonicalMode: "unsupported_version" };
  }
  return { state: "missing", canonicalMode: "missing" };
}

async function resumeInsideQueue(input: {
  dataRoot: string;
  fileOps: FileOps;
  capability: DirectorySyncCapability;
}): Promise<InternalRecoveryResult> {
  for (let iteration = 0; iteration < 32; iteration += 1) {
    let state: CollectedRecoveryState;
    try {
      state = await collectRecoveryState(input);
    } catch (error) {
      return resultForError(error);
    }
    const plan = planLibraryRecovery(state.observation);
    if (plan.action === "no_op") return finalInternalResult(state);
    if (plan.action === "recovery_conflict") return { state: "recovery_conflict" };
    if (plan.action === "recovery_not_supported") {
      if (input.capability.state === "unsupported") {
        return { state: "recovery_not_supported" };
      }
      try {
        const directories = state.hasActiveRecovery
          ? [input.dataRoot, state.paths.directory]
          : [input.dataRoot];
        await requireDurableNamespaces(directories, input.fileOps, input.capability);
      } catch (error) {
        return resultForError(error);
      }
      continue;
    }
    if (!plan.mutationAllowed) return { state: "recovery_conflict" };

    try {
      const confirmed = await collectRecoveryState(input);
      const confirmedPlan = planLibraryRecovery(confirmed.observation);
      if (!samePlan(plan, confirmedPlan)) continue;
      await executeMutation({
        state: confirmed,
        plan: confirmedPlan,
        fileOps: input.fileOps,
        capability: input.capability,
      });
    } catch (error) {
      return resultForError(error);
    }
  }
  return { state: "recovery_conflict" };
}

async function prepareRecovery(input: {
  dataRoot: string;
  fileOps: FileOps;
  capability: DirectorySyncCapability;
  idFactory: () => string;
  now: () => string;
  expectedFingerprint: string;
}): Promise<InternalRecoveryResult> {
  let current: CollectedRecoveryState;
  try {
    current = await collectRecoveryState(input);
  } catch (error) {
    return resultForError(error);
  }
  if (current.observation.pathSafety !== "safe") {
    return { state: "recovery_conflict" };
  }
  if (current.hasActiveRecovery) {
    const resumed = await resumeInsideQueue(input);
    if (resumed.state === "ready") return resumed;
    if (resumed.state !== "corrupt") return resumed;
    try {
      current = await collectRecoveryState(input);
    } catch (error) {
      return resultForError(error);
    }
  }
  if (
    current.canonical.mode !== "corrupt"
    || current.canonical.fingerprint !== input.expectedFingerprint
  ) {
    return {
      state: "fingerprint_changed",
      canonicalMode: current.canonical.mode,
      fingerprint: current.canonical.mode === "corrupt"
        ? current.canonical.fingerprint ?? undefined
        : undefined,
    };
  }
  if (!SHA256.test(input.expectedFingerprint)) {
    return {
      state: "fingerprint_changed",
      canonicalMode: "corrupt",
      fingerprint: current.canonical.fingerprint ?? undefined,
    };
  }

  let records;
  try {
    records = (await scanMeetingRecordObservations(input.dataRoot, input.fileOps))
      .map((observation) => classifyMeetingRecord({ ...observation, hasPlacement: false }));
  } catch {
    return { state: "recovery_io" };
  }
  const visible = records.filter((record) => record.kind === "live" && record.meetingId !== null);
  const recoveryId = input.idFactory();
  const libraryId = input.idFactory();
  const workspaceId = input.idFactory();
  const timestamp = input.now();
  let document: LibraryDocument;
  try {
    document = parseLibraryDocument({
      schemaVersion: 1,
      libraryId,
      revision: 0,
      defaultWorkspaceId: workspaceId,
      workspaces: [{
        id: workspaceId,
        name: "내 워크스페이스",
        order: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
      folders: [],
      placements: visible.map((record) => ({
        meetingId: record.meetingId as string,
        workspaceId,
        folderId: null,
      })),
    });
    deriveRecoveryBasenames(recoveryId);
  } catch {
    return { state: "recovery_conflict" };
  }
  const serialized = serializeDocument(document);
  const newHash = hash(serialized);
  if (newHash === input.expectedFingerprint) return { state: "recovery_conflict" };
  const paths = recoveryPaths(input.dataRoot, recoveryId);

  try {
    if (input.capability.state !== "supported") {
      await requireDurableNamespaces([input.dataRoot], input.fileOps, input.capability);
    }
    await ensureRecoveryDirectory({
      dataRoot: input.dataRoot,
      recoveryDirectory: paths.directory,
      fileOps: input.fileOps,
      capability: input.capability,
    });
    await assertMissing(paths.intent, input.fileOps);
    await assertMissing(paths.newTemp, input.fileOps);
    await assertMissing(paths.archive, input.fileOps);
    await assertMissing(paths.restoreTemp, input.fileOps);
    await writeExclusiveFile({ path: paths.newTemp, data: serialized, fileOps: input.fileOps });
    await requireDurableNamespaces([paths.directory], input.fileOps, input.capability);
    const intent: LibraryRecoveryIntent = {
      schemaVersion: 1,
      recoveryId,
      oldCanonicalSha256: input.expectedFingerprint,
      newLibraryId: libraryId,
      newDocumentSha256: newHash,
      phase: "intent_created",
    };
    await writeExclusiveFile({
      path: paths.intent,
      data: serializeIntent(intent),
      fileOps: input.fileOps,
    });
    await requireDurableNamespaces([paths.directory], input.fileOps, input.capability);
  } catch (error) {
    return resultForError(error);
  }

  const result = await resumeInsideQueue(input);
  if (result.state !== "ready") return result;
  return {
    ...result,
    document,
    archivePreserved: true,
    discoveredVisibleMeetingCount: visible.length,
    organizationReset: true,
  };
}

async function repairResolvedPlacements(
  dataRoot: string,
  document: LibraryDocument,
): Promise<void> {
  const updater = getStatusUpdater(dataRoot);
  let changed = false;
  for (const placement of document.placements) {
    try {
      const status = await updater.read(placement.meetingId);
      const resolution = status?.placementResolution;
      if (!resolution || (resolution.state !== "pending" && resolution.state !== "unavailable")) {
        continue;
      }
      await updater.update(placement.meetingId, (latest) => {
        const latestResolution = latest.placementResolution;
        if (
          !latestResolution
          || (latestResolution.state !== "pending" && latestResolution.state !== "unavailable")
        ) return latest;
        return {
          ...latest,
          placementResolution: {
            ...latestResolution,
            state: "resolved" as const,
            resolvedBy: "rebuild" as const,
            resolvedLibraryId: document.libraryId,
          },
        };
      });
      changed = true;
    } catch {
      // Canonical placement is authoritative; a later access retries this
      // advisory status repair without changing the rebuilt registry.
    }
  }
  if (changed) {
    const { invalidateOrganizationPending } = await import("@/lib/organizationPending");
    invalidateOrganizationPending();
  }
}

function toPublicResult(result: InternalRecoveryResult): LibraryRecoveryResult {
  if (result.state === "ready" && result.document) {
    return {
      state: "ready",
      version: versionOf(result.document),
      discoveredVisibleMeetingCount:
        result.discoveredVisibleMeetingCount ?? result.document.placements.length,
      organizationReset: result.organizationReset ?? false,
      archivePreserved: result.archivePreserved ?? false,
    };
  }
  if (result.state === "corrupt" && result.fingerprint) {
    return { state: "corrupt", fingerprint: result.fingerprint };
  }
  if (result.state === "fingerprint_changed") {
    return {
      state: "fingerprint_changed",
      currentMode: result.canonicalMode ?? "missing",
      ...(result.fingerprint ? { fingerprint: result.fingerprint } : {}),
    };
  }
  if (result.state === "missing") return { state: "missing" };
  if (result.state === "unsupported_version") return { state: "unsupported_version" };
  if (result.state === "recovery_not_supported") return { state: "recovery_not_supported" };
  if (result.state === "recovery_conflict") return { state: "recovery_conflict" };
  return { state: "recovery_io" };
}

export function createLibraryRecoveryExecutor(
  options: LibraryRecoveryExecutorOptions,
): LibraryRecoveryExecutor {
  const dataRoot = resolve(options.dataRoot);
  const fileOps = options.fileOps ?? createNodeFileOps();
  const capability = options.capability ?? createDirectorySyncCapability();
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  const finish = async (result: InternalRecoveryResult): Promise<LibraryRecoveryResult> => {
    if (result.state === "ready" && result.document) {
      await repairResolvedPlacements(dataRoot, result.document);
    }
    return toPublicResult(result);
  };

  return {
    rebuild: async ({ fingerprint }) => finish(await runInLibraryQueue(
      dataRoot,
      () => prepareRecovery({
        dataRoot,
        fileOps,
        capability,
        idFactory,
        now,
        expectedFingerprint: fingerprint,
      }),
    )),
    resume: async () => finish(await runInLibraryQueue(
      dataRoot,
      () => resumeInsideQueue({ dataRoot, fileOps, capability }),
    )),
  };
}
