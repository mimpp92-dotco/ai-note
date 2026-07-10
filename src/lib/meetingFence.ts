import { startMeetingCleanupSweep } from "@/lib/meetingCleanup";
import { inspectMeetingTombstone } from "@/lib/meetingTombstone";
import { publicErrorResponse } from "@/lib/publicApi";

export async function meetingFenceResponse(id: string): Promise<Response | null> {
  void startMeetingCleanupSweep().catch(() => {});
  const fence = await inspectMeetingTombstone(id);
  if (fence.state === "deleted") {
    return publicErrorResponse("meeting_deleted", 410, { meetingId: id });
  }
  if (fence.state === "ambiguous") {
    return publicErrorResponse("delete_state_ambiguous", 409, { meetingId: id, action: "reveal" });
  }
  return null;
}
