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
    attention: { meetingId: string; cursor: string } | null;
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
  const needsAttention = statuses
    .filter((status) => status.error?.action === "retry_summary")
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id, "en"));
  const processing = statuses.filter((status) =>
    status.error?.action !== "retry_summary"
    && (status.status === "transcribed" || status.status === "summarizing")).length;
  const cursor = attentionAfter ? decodeCursor(attentionAfter) : null;
  const attention = cursor
    ? needsAttention.find((status) => isAfter(status, cursor))
    : needsAttention[0];
  return {
    summaryWork: {
      processing,
      needsAttention: needsAttention.length,
      attention: attention
        ? {
            meetingId: attention.id,
            cursor: encodeCursor({ id: attention.id, startedAt: attention.startedAt }),
          }
        : null,
    },
    observedAt,
  };
}
