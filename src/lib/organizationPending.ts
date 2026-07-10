import { createHash } from "node:crypto";

import type { LibraryVersion } from "@/domain/library";
import { readFinalizeReceipt, type FinalizeLocation } from "@/lib/finalizeRecord";
import { readResolvedLibraryState } from "@/lib/libraryService";
import { toPublicMeetingListItem, type PublicMeetingListItem } from "@/lib/publicApi";

interface OrganizationPendingState {
  epoch: number;
}

declare global {
  var __aiNoteOrganizationPendingState: OrganizationPendingState | undefined;
}

function pendingState(): OrganizationPendingState {
  globalThis.__aiNoteOrganizationPendingState ??= { epoch: 0 };
  return globalThis.__aiNoteOrganizationPendingState;
}

export function invalidateOrganizationPending(): void {
  pendingState().epoch += 1;
}

export function resetOrganizationPendingStateForTests(): void {
  globalThis.__aiNoteOrganizationPendingState = { epoch: 0 };
}

export interface OrganizationPendingRow extends PublicMeetingListItem {
  organizationPending: true;
  resolution: "pending" | "unavailable";
  requested: FinalizeLocation | null;
  locationSource: "explicit" | "legacy_default" | "unavailable" | null;
  actual: null;
  action: "detail_probe";
}

export interface OrganizationPendingPage {
  count: number;
  rows: OrganizationPendingRow[];
  nextCursor: string | null;
  observedAt: string;
  sequence: string;
  version: LibraryVersion | null;
}

export class OrganizationPendingError extends Error {
  readonly code: "invalid_cursor" | "stale_cursor";

  constructor(code: OrganizationPendingError["code"]) {
    super(code);
    this.name = "OrganizationPendingError";
    this.code = code;
  }
}

interface PendingCursor {
  sequence: string;
  startedAt: string;
  id: string;
}

function encodeCursor(cursor: PendingCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): PendingCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(",") !== "id,sequence,startedAt"
    ) throw new Error("shape");
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.sequence !== "string"
      || !/^[a-f0-9]{64}$/u.test(candidate.sequence)
      || typeof candidate.startedAt !== "string"
      || typeof candidate.id !== "string"
    ) throw new Error("fields");
    return candidate as unknown as PendingCursor;
  } catch {
    throw new OrganizationPendingError("invalid_cursor");
  }
}

function afterCursor(row: OrganizationPendingRow, cursor: PendingCursor): boolean {
  return row.startedAt < cursor.startedAt
    || (row.startedAt === cursor.startedAt && row.id > cursor.id);
}

export async function readOrganizationPendingPage(input: {
  cursor?: string | null;
  limit?: number;
  now?: () => string;
} = {}): Promise<OrganizationPendingPage> {
  const state = await readResolvedLibraryState();
  const canonicalIds = new Set(state.document?.placements.map((placement) => placement.meetingId) ?? []);
  const candidates = state.records.filter((record) => (
    record.kind === "live"
    && record.meetingId !== null
    && record.status !== null
    && !canonicalIds.has(record.meetingId)
    && (record.status.placementResolution?.state === "pending"
      || record.status.placementResolution?.state === "unavailable")
  ));
  const rows: OrganizationPendingRow[] = [];
  const sequenceInputs: unknown[] = [];
  for (const record of candidates) {
    const status = record.status!;
    let receipt: Awaited<ReturnType<typeof readFinalizeReceipt>> = null;
    try {
      receipt = await readFinalizeReceipt(status.id);
    } catch {
      // A bad private receipt must not leak bytes or hide the recoverable row.
    }
    rows.push({
      ...toPublicMeetingListItem(status),
      organizationPending: true,
      resolution: status.placementResolution!.state as "pending" | "unavailable",
      requested: receipt?.requestedLocation ?? null,
      locationSource: receipt?.locationSource ?? null,
      actual: null,
      action: "detail_probe",
    });
    sequenceInputs.push({
      id: status.id,
      updatedAt: status.updatedAt,
      resolution: status.placementResolution,
      receipt: receipt
        ? {
            requestedLocation: receipt.requestedLocation,
            locationSource: receipt.locationSource,
            audioSha256: receipt.audioSha256,
          }
        : null,
    });
  }
  rows.sort((left, right) => (
    right.startedAt.localeCompare(left.startedAt) || left.id.localeCompare(right.id, "en")
  ));
  sequenceInputs.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
  const sequence = createHash("sha256").update(JSON.stringify({
    epoch: pendingState().epoch,
    rows: sequenceInputs,
  })).digest("hex");
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  if (cursor && cursor.sequence !== sequence) throw new OrganizationPendingError("stale_cursor");
  const remaining = cursor ? rows.filter((row) => afterCursor(row, cursor)) : rows;
  const requestedLimit = input.limit ?? 50;
  const limit = Math.min(100, Math.max(1, Number.isSafeInteger(requestedLimit) ? requestedLimit : 50));
  const pageRows = remaining.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    count: rows.length,
    rows: pageRows,
    nextCursor: remaining.length > pageRows.length && last
      ? encodeCursor({ sequence, startedAt: last.startedAt, id: last.id })
      : null,
    observedAt: (input.now ?? (() => new Date().toISOString()))(),
    sequence,
    version: state.version,
  };
}
