import { randomUUID } from "node:crypto";

import type { TranscriptionDispatch } from "@/domain/meeting";
import {
  assertMeetingOperationOwner,
  tryAcquireMeetingOperation,
  type MeetingOperationLease,
} from "@/lib/meetingLifecycle";
import { readStatus, retryStatusDurability, updateStatus } from "@/lib/status";
import { inspectTranscriptionPublication } from "@/lib/transcriptionArtifacts";
import { proposeWhisperJob } from "@/services/whisperClient";

export type EnqueueResult =
  | {
      ok: true;
      jobId: string;
      dispatchId: string;
      durability: "durable" | "best_effort";
      state: "sent" | "completed";
    }
  | { ok: false; reason: "not_found" | "already_transcribed" | "in_progress" };

function acceptedDurability(
  durability: "none" | "durable" | "best_effort" | "pending",
): "durable" | "best_effort" {
  if (durability === "durable" || durability === "best_effort") return durability;
  if (durability === "pending") throw new Error("status_durability_pending");
  throw new Error("status_not_committed");
}

function mergeDurability(
  a: "durable" | "best_effort",
  b: "durable" | "best_effort",
): "durable" | "best_effort" {
  return a === "best_effort" || b === "best_effort" ? "best_effort" : "durable";
}

async function markCompleted(
  id: string,
  ownerToken: string,
  dispatch: TranscriptionDispatch,
): Promise<void> {
  await updateStatus(id, ownerToken, (latest) => {
    if (latest.transcriptionDispatch?.dispatchId !== dispatch.dispatchId) return latest;
    return {
      ...latest,
      status: "transcribed",
      error: null,
      transcriptionDispatch: { ...latest.transcriptionDispatch, state: "completed" },
      whisper: { jobId: dispatch.dispatchId, progress: 1 },
    };
  });
}

export async function enqueueTranscription(
  id: string,
  options: { ownerToken?: string } = {},
): Promise<EnqueueResult> {
  let lease: MeetingOperationLease | null = null;
  if (options.ownerToken) assertMeetingOperationOwner(id, options.ownerToken);
  else {
    lease = await tryAcquireMeetingOperation(id, "transcribe_dispatch");
    if (!lease) return { ok: false, reason: "in_progress" };
  }
  const ownerToken = options.ownerToken ?? lease!.ownerToken;
  try {
    let status = await readStatus(id);
    if (!status) return { ok: false, reason: "not_found" };
    let durability: "durable" | "best_effort" = "durable";
    if (status.transcriptionDispatch) {
      durability = acceptedDurability(await retryStatusDurability(id));
    }

    const existingPublication = inspectTranscriptionPublication(
      id,
      status.transcriptionDispatch?.dispatchId,
    );
    if (existingPublication.state === "complete") {
      if (status.transcriptionDispatch) {
        await markCompleted(id, ownerToken, status.transcriptionDispatch);
      }
      return { ok: false, reason: "already_transcribed" };
    }
    if (existingPublication.state === "ambiguous") {
      throw new Error("transcription_publication_ambiguous");
    }
    if (status.status !== "recorded" && status.status !== "transcribing") {
      return { ok: false, reason: "already_transcribed" };
    }

    let dispatch = status.transcriptionDispatch;
    if (!dispatch) {
      dispatch = {
        dispatchId: randomUUID(),
        createdAt: new Date().toISOString(),
        state: "proposed",
      };
      const proposal = dispatch;
      const result = await updateStatus(id, ownerToken, (latest) => ({
        ...latest,
        status: "transcribing",
        error: null,
        transcriptionDispatch: proposal,
        whisper: { jobId: proposal.dispatchId, progress: 0 },
      }));
      durability = acceptedDurability(result.commit.durability);
    } else if (dispatch.state === "failed") {
      const existing = dispatch;
      const result = await updateStatus(id, ownerToken, (latest) =>
        latest.transcriptionDispatch?.dispatchId === existing.dispatchId
          ? {
              ...latest,
              status: "transcribing",
              error: null,
              transcriptionDispatch: { ...existing, state: "proposed" },
              whisper: { jobId: existing.dispatchId, progress: 0 },
            }
          : latest);
      durability = acceptedDurability(result.commit.durability);
      dispatch = { ...existing, state: "proposed" };
    }

    let response = await proposeWhisperJob({ meetingId: id, dispatchId: dispatch.dispatchId });
    if (response.status === "adopt") {
      const proposedId = dispatch.dispatchId;
      let adopted = false;
      const canonical: TranscriptionDispatch = {
        ...dispatch,
        dispatchId: response.dispatchId,
        state: "accepted",
      };
      const result = await updateStatus(id, ownerToken, (latest) => {
        if (latest.transcriptionDispatch?.dispatchId !== proposedId) return latest;
        adopted = true;
        return {
          ...latest,
          transcriptionDispatch: canonical,
          whisper: { jobId: canonical.dispatchId, progress: 0 },
        };
      });
      if (!adopted) throw new Error("transcription_dispatch_cas_failed");
      durability = mergeDurability(durability, acceptedDurability(result.commit.durability));
      dispatch = canonical;
      response = await proposeWhisperJob({ meetingId: id, dispatchId: dispatch.dispatchId });
      if (response.status === "adopt") throw new Error("transcription_dispatch_adopt_loop");
    }

    const responseState = response.status === "done" ? "accepted" : "sent";
    const canonicalId = dispatch.dispatchId;
    const sent = await updateStatus(id, ownerToken, (latest) =>
      latest.transcriptionDispatch?.dispatchId === canonicalId
        ? {
            ...latest,
            status: "transcribing",
            error: null,
            transcriptionDispatch: { ...latest.transcriptionDispatch, state: responseState },
            whisper: { jobId: canonicalId, progress: response.status === "done" ? 1 : 0 },
          }
        : latest);
    durability = mergeDurability(durability, acceptedDurability(sent.commit.durability));

    status = await readStatus(id);
    const publication = response.status === "done"
      ? inspectTranscriptionPublication(id, canonicalId)
      : { state: "incomplete" as const };
    if (publication.state === "complete" && status?.transcriptionDispatch) {
      await markCompleted(id, ownerToken, status.transcriptionDispatch);
      return {
        ok: true,
        jobId: canonicalId,
        dispatchId: canonicalId,
        durability: mergeDurability(durability, publication.durability),
        state: "completed",
      };
    }
    return {
      ok: true,
      jobId: canonicalId,
      dispatchId: canonicalId,
      durability,
      state: "sent",
    };
  } finally {
    lease?.release();
  }
}
