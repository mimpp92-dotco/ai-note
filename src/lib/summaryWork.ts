import type { ClassifiedMeetingRecord } from "@/domain/library";

interface AttentionCursorPayload {
  startedAt: string;
  id: string;
}

export class AttentionCursorError extends Error {
  readonly code = "invalid_attention_cursor";

  constructor() {
    super("invalid_attention_cursor");
    this.name = "AttentionCursorError";
  }
}

function encodeCursor(payload: AttentionCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): AttentionCursorPayload {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "id,startedAt"
    ) throw new Error("shape");
    const payload = value as Record<string, unknown>;
    if (typeof payload.id !== "string" || typeof payload.startedAt !== "string") {
      throw new Error("fields");
    }
    return { id: payload.id, startedAt: payload.startedAt };
  } catch {
    throw new AttentionCursorError();
  }
}

function isAfter(
  status: { id: string; startedAt: string },
  cursor: AttentionCursorPayload,
): boolean {
  return status.startedAt > cursor.startedAt
    || (status.startedAt === cursor.startedAt && status.id > cursor.id);
}

export interface SummaryWorkResult {
  summaryWork: {
    processing: number;
    needsAttention: number;
    attention: {
      meetingId: string;
      cursor: string;
      action: "retry_transcript_generation" | "retry_summary";
    } | null;
  };
  observedAt: string;
}

export function computeSummaryWork(
  records: readonly ClassifiedMeetingRecord[],
  attentionAfter?: string | null,
  observedAt = new Date().toISOString(),
): SummaryWorkResult {
  const statuses = records
    .filter((record) => record.kind === "live" && record.status !== null)
    .map((record) => record.status!);
  const needsAttention = statuses.flatMap((status) => {
    const action = status.error?.action;
    return action === "retry_transcript_generation" || action === "retry_summary"
      ? [{ status, action }]
      : [];
  }).sort((a, b) => (
    a.status.startedAt.localeCompare(b.status.startedAt)
    || a.status.id.localeCompare(b.status.id, "en")
  ));
  const processing = statuses.filter((status) => {
    if (
      status.error?.action === "retry_transcript_generation"
      || status.error?.action === "retry_summary"
    ) return false;
    const kind = status.summarizeAttempt?.kind;
    if (kind === "manual_edit") return false;
    if (kind !== undefined) return true;
    return status.status === "transcribed" || status.status === "summarizing";
  }).length;
  const cursor = attentionAfter ? decodeCursor(attentionAfter) : null;
  const attention = cursor
    ? needsAttention.find(({ status }) => isAfter(status, cursor))
    : needsAttention[0];
  return {
    summaryWork: {
      processing,
      needsAttention: needsAttention.length,
      attention: attention
        ? {
            meetingId: attention.status.id,
            cursor: encodeCursor({
              id: attention.status.id,
              startedAt: attention.status.startedAt,
            }),
            action: attention.action,
          }
        : null,
    },
    observedAt,
  };
}
