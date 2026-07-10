export interface RecorderResultLocation {
  workspaceId: string;
  folderId: string | null;
}

export interface RecorderFinalizeResultContract {
  artifact: "published" | "already_published";
  durability: "durable" | "best_effort" | "pending";
  playback: "ready" | "failed" | "unchanged";
  version?: { libraryId: string; revision: number } | null;
  placement: {
    requested: RecorderResultLocation | null;
    actual: RecorderResultLocation | null;
    outcome: "saved" | "fallback" | "unavailable";
    fallbackReason: "folder_missing" | "workspace_missing" | "library_degraded" | null;
  };
  transcription: "accepted" | "failed" | "unchanged";
  status?: string | null;
  probe?: "published";
}

export type RecorderRecoveryAction =
  | "retry_upload"
  | "retry_playback"
  | "retry_placement"
  | "refresh_actual"
  | "retry_transcription"
  | "open_organization_pending";

export interface RecorderFinalizeDescription {
  artifactTone: "success" | "warning";
  artifactMessage: string;
  placementMessage: string;
  actions: RecorderRecoveryAction[];
}

export function describeRecorderFinalizeResult(
  result: RecorderFinalizeResultContract,
): RecorderFinalizeDescription {
  const artifactMessage = result.durability === "pending"
    ? "녹음은 저장됐으며 디스크에서 안정화하는 중입니다. 다시 업로드하지 마세요."
    : result.durability === "best_effort"
      ? "녹음은 현재 플랫폼에서 가능한 가장 강한 방식으로 저장됐습니다."
      : "녹음 원본을 안전하게 저장했습니다.";
  const actions: RecorderRecoveryAction[] = [];
  if (result.playback === "failed") actions.push("retry_playback");
  if (result.transcription === "failed") actions.push("retry_transcription");
  let placementMessage: string;
  if (result.placement.outcome === "saved") {
    placementMessage = "요청한 위치에 저장했습니다.";
  } else if (result.placement.outcome === "fallback") {
    placementMessage = result.placement.fallbackReason === "folder_missing"
      ? "요청한 폴더를 찾지 못해 같은 워크스페이스의 미분류에 저장했습니다."
      : "요청한 워크스페이스를 찾지 못해 현재 기본 워크스페이스의 미분류에 저장했습니다.";
  } else if (result.placement.requested) {
    placementMessage = "녹음 원본은 저장됐지만 요청한 조직 위치를 아직 저장하지 못했습니다.";
    actions.push("retry_placement", "open_organization_pending");
  } else {
    placementMessage = "녹음 원본은 저장됐지만 연결할 조직 위치가 없습니다.";
    actions.push("refresh_actual", "open_organization_pending");
  }
  return {
    artifactTone: result.durability === "durable" ? "success" : "warning",
    artifactMessage,
    placementMessage,
    actions,
  };
}
