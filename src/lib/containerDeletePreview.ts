import type { ClassifiedMeetingRecord } from "@/domain/library";
import {
  listActiveFinalizeLocationIntents,
  readFinalizeReceipt,
  type FinalizeIntent,
  type FinalizeReceipt,
} from "@/lib/finalizeRecord";

export type ContainerIntentTarget =
  | { kind: "folder"; workspaceId: string; folderId: string }
  | { kind: "workspace"; workspaceId: string };

export async function countPendingFinalizeLocationIntents(
  records: readonly ClassifiedMeetingRecord[],
  target: ContainerIntentTarget,
  readReceipt: (meetingId: string) => Promise<FinalizeReceipt | null> = readFinalizeReceipt,
  readActiveIntents: () => Promise<readonly FinalizeIntent[]> = listActiveFinalizeLocationIntents,
): Promise<number> {
  let count = 0;
  const countedMeetingIds = new Set<string>();
  for (const record of records) {
    const resolution = record.status?.placementResolution?.state;
    if (
      record.kind !== "live"
      || record.meetingId === null
      || (resolution !== "pending" && resolution !== "unavailable")
    ) continue;
    let receipt: FinalizeReceipt | null;
    try {
      receipt = await readReceipt(record.meetingId);
    } catch {
      continue;
    }
    const requested = receipt?.requestedLocation;
    if (!requested || requested.workspaceId !== target.workspaceId) continue;
    if (target.kind === "workspace" || requested.folderId === target.folderId) {
      count += 1;
      countedMeetingIds.add(record.meetingId);
    }
  }
  let activeIntents: readonly FinalizeIntent[];
  try {
    activeIntents = await readActiveIntents();
  } catch {
    activeIntents = [];
  }
  for (const intent of activeIntents) {
    if (countedMeetingIds.has(intent.id)) continue;
    const requested = intent.requestedLocation;
    if (!requested || requested.workspaceId !== target.workspaceId) continue;
    if (target.kind === "workspace" || requested.folderId === target.folderId) {
      count += 1;
      countedMeetingIds.add(intent.id);
    }
  }
  return count;
}
