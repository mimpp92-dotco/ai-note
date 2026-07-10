import { z } from "zod";

import {
  MEETING_STATUSES,
  type StatusJson,
} from "@/domain/meeting";

export const LIBRARY_SCHEMA_VERSION = 1 as const;
export const LIBRARY_COLORS = ["brown", "sand", "amber", "olive", "sage"] as const;

export type LibraryColor = (typeof LIBRARY_COLORS)[number];

export interface LibraryWorkspace {
  id: string;
  name: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryFolder {
  id: string;
  workspaceId: string;
  parentFolderId: string | null;
  name: string;
  color: LibraryColor;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryPlacement {
  meetingId: string;
  workspaceId: string;
  folderId: string | null;
}

export interface LibraryDocument {
  schemaVersion: typeof LIBRARY_SCHEMA_VERSION;
  libraryId: string;
  revision: number;
  defaultWorkspaceId: string;
  workspaces: LibraryWorkspace[];
  folders: LibraryFolder[];
  placements: LibraryPlacement[];
}

export interface LibraryVersion {
  libraryId: string;
  revision: number;
}

const UNICODE_WHITESPACE_RUN = /\p{White_Space}+/gu;
const LEADING_OR_TRAILING_UNICODE_WHITESPACE =
  /^\p{White_Space}+|\p{White_Space}+$/gu;
const C0_C1_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const SAFE_MEETING_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function trimUnicodeWhitespace(value: string): string {
  return value.replace(LEADING_OR_TRAILING_UNICODE_WHITESPACE, "");
}

export function libraryNameKey(value: string): string {
  return trimUnicodeWhitespace(value)
    .normalize("NFKC")
    .replace(UNICODE_WHITESPACE_RUN, " ")
    .toLowerCase();
}

function isValidDisplayName(value: string): boolean {
  if (C0_C1_CONTROL.test(value) || BIDI_CONTROL.test(value)) return false;
  const trimmed = trimUnicodeWhitespace(value);
  const length = Array.from(trimmed).length;
  return length >= 1 && length <= 80;
}

const displayNameSchema = z
  .string()
  .refine(isValidDisplayName, "이름은 제어 문자 없이 1~80자여야 합니다")
  .transform(trimUnicodeWhitespace);

const uuidSchema = z.string().uuid();
const orderSchema = z.number().int().nonnegative().safe();
const timestampSchema = z.string().datetime({ offset: true });
const meetingIdSchema = z.string().min(1).max(128).regex(SAFE_MEETING_ID);

const workspaceSchema = z
  .object({
    id: uuidSchema,
    name: displayNameSchema,
    order: orderSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const folderSchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    parentFolderId: uuidSchema.nullable(),
    name: displayNameSchema,
    color: z.enum(LIBRARY_COLORS),
    order: orderSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const placementSchema = z
  .object({
    meetingId: meetingIdSchema,
    workspaceId: uuidSchema,
    folderId: uuidSchema.nullable(),
  })
  .strict();

function addCustomIssue(
  ctx: z.RefinementCtx,
  message: string,
  path: PropertyKey[] = [],
): void {
  ctx.addIssue({ code: "custom", message, path });
}

export const libraryDocumentSchema = z
  .object({
    schemaVersion: z.literal(LIBRARY_SCHEMA_VERSION),
    libraryId: uuidSchema,
    revision: orderSchema,
    defaultWorkspaceId: uuidSchema,
    workspaces: z.array(workspaceSchema).min(1),
    folders: z.array(folderSchema),
    placements: z.array(placementSchema),
  })
  .strict()
  .superRefine((document, ctx) => {
    const workspaceById = new Map<string, (typeof document.workspaces)[number]>();
    const workspaceNameKeys = new Set<string>();
    for (const [index, workspace] of document.workspaces.entries()) {
      if (workspaceById.has(workspace.id)) {
        addCustomIssue(ctx, "워크스페이스 ID는 중복될 수 없습니다", ["workspaces", index, "id"]);
      }
      workspaceById.set(workspace.id, workspace);
      const key = libraryNameKey(workspace.name);
      if (workspaceNameKeys.has(key)) {
        addCustomIssue(ctx, "워크스페이스 이름은 중복될 수 없습니다", ["workspaces", index, "name"]);
      }
      workspaceNameKeys.add(key);
    }

    if (!workspaceById.has(document.defaultWorkspaceId)) {
      addCustomIssue(ctx, "기본 워크스페이스가 존재하지 않습니다", ["defaultWorkspaceId"]);
    }

    const folderById = new Map<string, (typeof document.folders)[number]>();
    for (const [index, folder] of document.folders.entries()) {
      if (folderById.has(folder.id)) {
        addCustomIssue(ctx, "폴더 ID는 중복될 수 없습니다", ["folders", index, "id"]);
      }
      folderById.set(folder.id, folder);
    }

    const siblingNameKeys = new Set<string>();
    for (const [index, folder] of document.folders.entries()) {
      if (!workspaceById.has(folder.workspaceId)) {
        addCustomIssue(ctx, "폴더의 워크스페이스가 존재하지 않습니다", ["folders", index, "workspaceId"]);
      }

      if (folder.parentFolderId !== null) {
        const parent = folderById.get(folder.parentFolderId);
        if (!parent) {
          addCustomIssue(ctx, "상위 폴더가 존재하지 않습니다", ["folders", index, "parentFolderId"]);
        } else if (parent.workspaceId !== folder.workspaceId) {
          addCustomIssue(ctx, "상위 폴더는 같은 워크스페이스여야 합니다", [
            "folders",
            index,
            "parentFolderId",
          ]);
        }
      }

      const siblingKey = JSON.stringify([
        folder.workspaceId,
        folder.parentFolderId,
        libraryNameKey(folder.name),
      ]);
      if (siblingNameKeys.has(siblingKey)) {
        addCustomIssue(ctx, "같은 위치의 폴더 이름은 중복될 수 없습니다", ["folders", index, "name"]);
      }
      siblingNameKeys.add(siblingKey);
    }

    const depthMemo = new Map<string, number>();
    const depthOf = (folderId: string, stack: Set<string>): number => {
      const memoized = depthMemo.get(folderId);
      if (memoized !== undefined) return memoized;
      if (stack.has(folderId)) return Number.POSITIVE_INFINITY;
      const folder = folderById.get(folderId);
      if (!folder) return Number.POSITIVE_INFINITY;
      if (folder.parentFolderId === null) {
        depthMemo.set(folderId, 1);
        return 1;
      }
      const nextStack = new Set(stack);
      nextStack.add(folderId);
      const parentDepth = depthOf(folder.parentFolderId, nextStack);
      const depth = parentDepth + 1;
      if (Number.isFinite(depth)) depthMemo.set(folderId, depth);
      return depth;
    };

    for (const [index, folder] of document.folders.entries()) {
      const depth = depthOf(folder.id, new Set());
      if (!Number.isFinite(depth)) {
        addCustomIssue(ctx, "폴더 트리에 순환 또는 잘못된 참조가 있습니다", ["folders", index, "parentFolderId"]);
      } else if (depth > 3) {
        addCustomIssue(ctx, "폴더 깊이는 최대 3단계입니다", ["folders", index, "parentFolderId"]);
      }
    }

    const placementMeetingIds = new Set<string>();
    for (const [index, placement] of document.placements.entries()) {
      if (placementMeetingIds.has(placement.meetingId)) {
        addCustomIssue(ctx, "회의는 정확히 한 위치에만 배치할 수 있습니다", [
          "placements",
          index,
          "meetingId",
        ]);
      }
      placementMeetingIds.add(placement.meetingId);

      if (!workspaceById.has(placement.workspaceId)) {
        addCustomIssue(ctx, "배치의 워크스페이스가 존재하지 않습니다", [
          "placements",
          index,
          "workspaceId",
        ]);
      }
      if (placement.folderId !== null) {
        const folder = folderById.get(placement.folderId);
        if (!folder) {
          addCustomIssue(ctx, "배치의 폴더가 존재하지 않습니다", ["placements", index, "folderId"]);
        } else if (folder.workspaceId !== placement.workspaceId) {
          addCustomIssue(ctx, "배치의 폴더와 워크스페이스가 일치하지 않습니다", [
            "placements",
            index,
            "folderId",
          ]);
        }
      }
    }
  });

export function parseLibraryDocument(input: unknown): LibraryDocument {
  return libraryDocumentSchema.parse(input) as LibraryDocument;
}

export function safeParseLibraryDocument(input: unknown):
  | { success: true; data: LibraryDocument }
  | { success: false; error: z.ZodError } {
  const result = libraryDocumentSchema.safeParse(input);
  if (result.success) return { success: true, data: result.data as LibraryDocument };
  return result;
}

export function compareLibraryOrder<T extends { order: number; id: string }>(a: T, b: T): number {
  return a.order - b.order || a.id.localeCompare(b.id, "en");
}

const statusErrorSchema = z
  .object({
    code: z.string().optional(),
    message: z.string(),
    action: z.enum(["retry_transcription", "retry_summary"]),
  })
  .passthrough();

const whisperStateSchema = z
  .object({
    jobId: z.string().nullable(),
    progress: z.number().finite().min(0).max(1),
  })
  .passthrough();

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const transcriptionDispatchSchema = z
  .object({
    dispatchId: uuidSchema,
    createdAt: timestampSchema,
    state: z.enum(["proposed", "accepted", "sent", "completed", "failed"]),
  })
  .strict();

const placementResolutionSchema = z.object({
  state: z.enum(["pending", "resolved", "unavailable"]),
  receiptHash: sha256Schema,
  resolvedBy: z.literal("rebuild").optional(),
  resolvedLibraryId: uuidSchema.optional(),
}).strict().superRefine((resolution, context) => {
  const hasBy = resolution.resolvedBy !== undefined;
  const hasLibrary = resolution.resolvedLibraryId !== undefined;
  if (hasBy !== hasLibrary || (hasBy && resolution.state !== "resolved")) {
    context.addIssue({
      code: "custom",
      message: "rebuild resolution metadata requires a resolved state and complete identity",
    });
  }
});

const statusPathsSchema = z
  .object({
    audio: z.string().min(1),
    play: z.string().min(1),
    raw: z.string().min(1),
    transcript: z.string().min(1),
    summary: z.string().min(1),
    segments: z.string().min(1),
  })
  .passthrough();

const reviewInputSchema = z
  .object({ participants: z.array(z.string()) })
  .passthrough();

const summarizeAttemptSchema = z
  .object({
    attemptId: uuidSchema,
    kind: z.enum(["initial", "resummarize"]),
    startedAt: timestampSchema,
    preTranscriptHash: sha256Schema.optional(),
    preSummaryHash: sha256Schema.optional(),
  })
  .strict();

export const statusJsonSchema = z
  .object({
    id: meetingIdSchema,
    title: z.string(),
    titleOverride: z.string().optional(),
    status: z.enum(MEETING_STATUSES),
    error: statusErrorSchema.nullable(),
    startedAt: timestampSchema,
    endedAt: timestampSchema.nullable(),
    durationMs: z.number().int().nonnegative().safe(),
    audioMime: z.string().min(1),
    whisper: whisperStateSchema,
    transcriptionDispatch: transcriptionDispatchSchema.optional(),
    placementResolution: placementResolutionSchema.optional(),
    paths: statusPathsSchema,
    review: reviewInputSchema.optional().transform((value) => value ?? { participants: [] }),
    summarizeAttempts: z.number().int().nonnegative().safe().optional(),
    summarizeAttempt: summarizeAttemptSchema.optional(),
    updatedAt: timestampSchema,
  })
  .passthrough();

export function parseStatusJson(input: unknown, expectedMeetingId?: string): StatusJson {
  const parsed = statusJsonSchema.parse(input) as StatusJson;
  if (expectedMeetingId !== undefined && parsed.id !== expectedMeetingId) {
    throw new Error("status_meeting_id_mismatch");
  }
  return parsed;
}

export function parseStatusJsonText(text: string, expectedMeetingId?: string): StatusJson {
  let input: unknown;
  try {
    input = JSON.parse(text) as unknown;
  } catch {
    throw new Error("status_json_malformed");
  }
  return parseStatusJson(input, expectedMeetingId);
}

export function mergeStatusJson(
  current: StatusJson,
  patch: Partial<StatusJson> & Record<string, unknown>,
  expectedMeetingId = current.id,
): StatusJson {
  return parseStatusJson({ ...current, ...patch }, expectedMeetingId);
}

export type MeetingRecordEntryKind =
  | "published"
  | "finalize_staging"
  | "summarize_staging"
  | "deleted"
  | "delete_ambiguous"
  | "unknown";

export type MeetingStatusObservation =
  | { kind: "valid"; value: StatusJson }
  | { kind: "missing" }
  | { kind: "corrupt" }
  | { kind: "unreadable"; code: string };

export interface MeetingRecordObservation {
  entryKind: MeetingRecordEntryKind;
  meetingId?: string;
  safety: "safe" | "unsafe";
  status: MeetingStatusObservation;
  hasAudio: boolean;
  hasPlacement?: boolean;
}

export type MeetingRecordKind =
  | "live"
  | "corrupt_status"
  | "unreadable_status"
  | "unsafe_record"
  | "incomplete"
  | "hidden_staging"
  | "hidden_deleted";

export interface ClassifiedMeetingRecord {
  kind: MeetingRecordKind;
  meetingId: string | null;
  hasPlacement: boolean;
  visible: boolean;
  preservePlacement: boolean;
  status: StatusJson | null;
}

function classified(
  observation: MeetingRecordObservation,
  kind: MeetingRecordKind,
  options: { visible?: boolean; preservePlacement?: boolean; status?: StatusJson | null } = {},
): ClassifiedMeetingRecord {
  return {
    kind,
    meetingId: observation.meetingId ?? null,
    hasPlacement: observation.hasPlacement ?? false,
    visible: options.visible ?? false,
    preservePlacement: options.preservePlacement ?? false,
    status: options.status ?? null,
  };
}

export function classifyMeetingRecord(
  observation: MeetingRecordObservation,
): ClassifiedMeetingRecord {
  if (observation.safety === "unsafe") {
    return classified(observation, "unsafe_record", { preservePlacement: true });
  }
  if (observation.entryKind === "deleted") {
    return classified(observation, "hidden_deleted");
  }
  if (observation.entryKind === "delete_ambiguous") {
    return classified(observation, "unsafe_record", { preservePlacement: true });
  }
  if (
    observation.entryKind === "finalize_staging"
    || observation.entryKind === "summarize_staging"
  ) {
    return classified(observation, "hidden_staging");
  }
  if (observation.entryKind !== "published") {
    return classified(observation, "incomplete", { preservePlacement: true });
  }

  if (observation.status.kind === "corrupt") {
    return classified(observation, "corrupt_status", { preservePlacement: true });
  }
  if (observation.status.kind === "unreadable") {
    return classified(observation, "unreadable_status", { preservePlacement: true });
  }
  if (observation.status.kind === "missing") {
    return classified(observation, "incomplete", { preservePlacement: true });
  }
  if (
    observation.meetingId === undefined
    || observation.status.value.id !== observation.meetingId
  ) {
    return classified(observation, "corrupt_status", { preservePlacement: true });
  }
  return classified(observation, "live", {
    visible: true,
    preservePlacement: true,
    status: observation.status.value,
  });
}

export interface MeetingRecordCounts {
  visibleMeetingCount: number;
  affectedPlacementCount: number;
  hiddenInvalidStatusCount: number;
}

const INVALID_RECORD_KINDS = new Set<MeetingRecordKind>([
  "corrupt_status",
  "unreadable_status",
  "unsafe_record",
]);

export function countMeetingRecords(
  records: readonly ClassifiedMeetingRecord[],
): MeetingRecordCounts {
  const counts: MeetingRecordCounts = {
    visibleMeetingCount: 0,
    affectedPlacementCount: 0,
    hiddenInvalidStatusCount: 0,
  };
  for (const record of records) {
    if (record.visible) counts.visibleMeetingCount += 1;
    if (INVALID_RECORD_KINDS.has(record.kind)) {
      counts.hiddenInvalidStatusCount += 1;
      if (record.hasPlacement) counts.affectedPlacementCount += 1;
    }
  }
  return counts;
}

// Exported for scanner inventory/contract tests. Every filesystem scanner must
// produce MeetingRecordObservation and call this exact classifier.
export const MEETING_RECORD_CLASSIFIER_CONTRACT = "classifyMeetingRecord:v1" as const;
