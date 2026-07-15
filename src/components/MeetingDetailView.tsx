"use client";

import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { AppDialog } from "@/components/AppDialog";
import { CopyButton } from "@/components/CopyButton";
import { LibraryLocationPicker } from "@/components/LibraryLocationPicker";
import {
  type EditorStatus,
  type SummaryEditorDraft,
  SummaryEditor,
  TranscriptEditor,
  createSummaryEditorDraft,
  normalizeTranscriptDraft,
  summaryDraftToEditable,
} from "@/components/MeetingContentEditors";
import { useOptionalLibrary } from "@/components/LibraryProvider";
import { GuardedLink as Link } from "@/components/RecorderNavigation";
import { useOptionalRecorderSession } from "@/components/RecorderSessionProvider";
import { Tabs, type TabItem } from "@/components/Tabs";
import { type LlmReadiness, getLlmReadiness } from "@/components/healthStatus";
import { useHealth } from "@/components/useHealth";
import type { ErrorAction, MeetingStatus, ReviewInput } from "@/domain/meeting";
import type { EditableSummary, Summary } from "@/domain/summary";
import { resolvePostMoveDetailSource } from "@/lib/detailSource";
import { formatLocationBreadcrumb } from "@/lib/libraryClient";
import type { LibraryMeetingScope } from "@/lib/libraryQuery";
import { formatMeetingDate, STATUS_LABELS } from "@/lib/meetingLabels";
import { formatDuration } from "@/lib/recorder";
import { formatSummaryMarkdown } from "@/lib/summaryMarkdown";

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface MeetingDetailStatus {
  id: string;
  title: string;
  status: MeetingStatus;
  error: { message: string; action: ErrorAction } | null;
  startedAt: string;
  review: ReviewInput;
  contentOperation?: "initial" | "transcript" | "summary" | null;
}

export interface ContentPairRevision {
  transcriptSha256: string;
  summarySha256: string;
}

export interface MeetingContentMetadata {
  state: "stable" | "active" | "interrupted" | "ambiguous" | "missing" | "source_conflict";
  revision: ContentPairRevision | null;
  transcriptSource: "generated" | "manual" | null;
  summarySource: "generated" | "manual" | null;
  summaryOutdated: boolean | null;
}

export interface MeetingDetailData {
  id: string;
  status: MeetingDetailStatus;
  transcript: { text: string; corrected: boolean };
  segments: Segment[];
  summary: Summary | null;
  content?: MeetingContentMetadata;
  hasAudio: boolean;
  resummarizeInflight?: boolean;
  backHref?: string;
  location?: { workspaceId: string; folderId: string | null } | null;
  source?: Exclude<LibraryMeetingScope, { kind: "global" }>;
  sourceAccepted?: boolean;
  canonicalDetailHref?: string;
  attentionAfter?: string | null;
  initialTab?: "script" | "summary";
}

const TRANSCRIPT_GENERATION_TIMEOUT_MS = 1_800_000 + 30_000;
const SUMMARY_GENERATION_TIMEOUT_MS = 2 * 1_800_000 + 30_000;

const ACTION_CONTROL_CLASS =
  "inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-line bg-panel px-3 py-2 text-[13px] font-medium text-accent transition-colors hover:bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50";
const PRIMARY_CONTROL_CLASS =
  "inline-flex min-h-11 items-center justify-center rounded-md bg-ink px-4 py-2 text-[13px] font-semibold text-bg transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50";

type EditorMode = "transcript" | "summary";
type GenerationMode = "transcript" | "summary";
type SaveStage = "idle" | "saving" | "verifying";

interface ConfirmedContent {
  transcript: string;
  summary: Summary;
  revision: ContentPairRevision;
  transcriptSource: "generated" | "manual";
  summarySource: "generated" | "manual";
  summaryOutdated: boolean;
}

interface ContentResource {
  transcript: string;
  summary: EditableSummary;
  revision: ContentPairRevision;
  transcriptSource: "generated" | "manual";
  summarySource: "generated" | "manual";
  summaryOutdated: boolean;
  pairState: "stable";
  durability?: "durable" | "best_effort" | "pending";
}

function summaryEditable(summary: Summary): EditableSummary {
  return {
    oneLine: summary.oneLine,
    purpose: summary.purpose,
    highlights: [...summary.highlights],
    discussion: [...summary.discussion],
    decisions: [...summary.decisions],
    actionItems: summary.actionItems.map((item) => ({ ...item })),
    risks: [...summary.risks],
    followups: [...summary.followups],
  };
}

function emptyEditableSummary(): EditableSummary {
  return {
    oneLine: "",
    purpose: "",
    highlights: [],
    discussion: [],
    decisions: [],
    actionItems: [],
    risks: [],
    followups: [],
  };
}

function sameRevision(left: ContentPairRevision, right: ContentPairRevision): boolean {
  return left.transcriptSha256 === right.transcriptSha256
    && left.summarySha256 === right.summarySha256;
}

function sameEditableSummary(left: EditableSummary, right: EditableSummary): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function parseEditableSummary(value: unknown): EditableSummary | null {
  if (!isRecord(value)) return null;
  const exactKeys = [
    "oneLine",
    "purpose",
    "highlights",
    "discussion",
    "decisions",
    "actionItems",
    "risks",
    "followups",
  ];
  if (Object.keys(value).length !== exactKeys.length || exactKeys.some((key) => !(key in value))) return null;
  const stringLists = ["highlights", "discussion", "decisions", "risks", "followups"] as const;
  if (typeof value.oneLine !== "string" || typeof value.purpose !== "string") return null;
  if (stringLists.some((key) => (
    !Array.isArray(value[key])
    || !value[key].every((item) => typeof item === "string")
  ))) return null;
  if (!Array.isArray(value.actionItems) || !value.actionItems.every((item) => (
    isRecord(item)
    && Object.keys(item).length === 3
    && typeof item.owner === "string"
    && typeof item.task === "string"
    && typeof item.due === "string"
  ))) return null;
  return value as unknown as EditableSummary;
}

function parseContentResource(value: unknown, durabilityRequired: boolean): ContentResource | null {
  if (!isRecord(value)) return null;
  const summary = parseEditableSummary(value.summary);
  const revision = value.revision;
  const durability = value.durability;
  if (
    typeof value.transcript !== "string"
    || !summary
    || !isRecord(revision)
    || Object.keys(revision).length !== 2
    || !isSha256(revision.transcriptSha256)
    || !isSha256(revision.summarySha256)
    || (value.transcriptSource !== "generated" && value.transcriptSource !== "manual")
    || (value.summarySource !== "generated" && value.summarySource !== "manual")
    || typeof value.summaryOutdated !== "boolean"
    || value.pairState !== "stable"
    || (durabilityRequired && durability !== "durable" && durability !== "best_effort" && durability !== "pending")
    || (!durabilityRequired && durability !== undefined)
  ) return null;
  const allowed = new Set([
    "transcript",
    "summary",
    "revision",
    "transcriptSource",
    "summarySource",
    "summaryOutdated",
    "pairState",
    ...(durabilityRequired ? ["durability"] : []),
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  return {
    transcript: value.transcript,
    summary,
    revision: {
      transcriptSha256: revision.transcriptSha256,
      summarySha256: revision.summarySha256,
    },
    transcriptSource: value.transcriptSource,
    summarySource: value.summarySource,
    summaryOutdated: value.summaryOutdated,
    pairState: "stable",
    ...(durabilityRequired ? { durability: durability as ContentResource["durability"] } : {}),
  };
}

function incomingConfirmed(
  content: MeetingContentMetadata | undefined,
  transcript: MeetingDetailData["transcript"],
  summary: Summary | null,
): ConfirmedContent | null {
  if (
    (content?.state !== "stable" && content?.state !== "active")
    || !content.revision
    || !content.transcriptSource
    || !content.summarySource
    || content.summaryOutdated === null
    || !transcript.corrected
    || !summary
  ) return null;
  return {
    transcript: transcript.text,
    summary,
    revision: content.revision,
    transcriptSource: content.transcriptSource,
    summarySource: content.summarySource,
    summaryOutdated: content.summaryOutdated,
  };
}

function resourceToConfirmed(resource: ContentResource, canonical: Summary): ConfirmedContent {
  return {
    transcript: resource.transcript,
    summary: { ...canonical, ...resource.summary },
    revision: resource.revision,
    transcriptSource: resource.transcriptSource,
    summarySource: resource.summarySource,
    summaryOutdated: resource.summaryOutdated,
  };
}

function contentResourceMatches(
  mode: EditorMode,
  resource: ContentResource,
  intended: string | EditableSummary,
  before: ConfirmedContent,
): boolean {
  if (mode === "transcript") {
    return typeof intended === "string"
      && resource.transcript === intended
      && sameEditableSummary(resource.summary, summaryEditable(before.summary));
  }
  return typeof intended !== "string"
    && sameEditableSummary(resource.summary, intended)
    && resource.transcript === before.transcript;
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function publicError(body: unknown): { code: string; operation?: string } | null {
  if (!isRecord(body) || !isRecord(body.error) || typeof body.error.code !== "string") return null;
  const details = body.error.details;
  return {
    code: body.error.code,
    ...(isRecord(details) && typeof details.operation === "string"
      ? { operation: details.operation }
      : {}),
  };
}

function operationLabel(operation: string | undefined): string {
  if (operation === "transcript_regenerate" || operation === "transcript") return "전체 스크립트 생성";
  if (operation === "summary_regenerate" || operation === "summary") return "회의록 요약 생성";
  if (operation === "manual_edit") return "내용 저장";
  return "다른 내용 작업";
}

export function MeetingDetailView({
  id,
  status,
  transcript,
  segments,
  summary,
  content,
  hasAudio,
  resummarizeInflight = false,
  backHref = "/",
  location = null,
  source,
  sourceAccepted = true,
  canonicalDetailHref,
  attentionAfter = null,
  initialTab = "script",
}: MeetingDetailData) {
  const router = useRouter();
  const recorderSession = useOptionalRecorderSession();
  const library = useOptionalLibrary();
  const refreshSummaryWork = library?.refreshSummaryWork;
  const { llm } = useHealth();
  const readiness = getLlmReadiness(llm);

  const firstIncoming = incomingConfirmed(content, transcript, summary);
  const [tab, setTab] = useState<"script" | "summary">(initialTab);
  const [confirmed, setConfirmed] = useState<ConfirmedContent | null>(() => firstIncoming);
  const [transcriptDraft, setTranscriptDraft] = useState(() => firstIncoming?.transcript ?? transcript.text);
  const [summaryDraft, setSummaryDraft] = useState<SummaryEditorDraft>(() => createSummaryEditorDraft(
    firstIncoming ? summaryEditable(firstIncoming.summary) : emptyEditableSummary(),
  ));
  const [editorMode, setEditorMode] = useState<EditorMode | null>(null);
  const [saveStage, setSaveStage] = useState<SaveStage>("idle");
  const [editorStatus, setEditorStatus] = useState<EditorStatus | null>(null);
  const [saveOutcome, setSaveOutcome] = useState<"none" | "conflict" | "ambiguous">("none");
  const [focusRequest, setFocusRequest] = useState(0);
  const [discardRequest, setDiscardRequest] = useState<{ next: EditorMode | null } | null>(null);
  const [latestConfirming, setLatestConfirming] = useState(false);
  const [contentNotice, setContentNotice] = useState<{
    scope: EditorMode;
    status: EditorStatus;
  } | null>(null);
  const [externalSyncStatus, setExternalSyncStatus] = useState<EditorStatus | null>(null);

  const [generationDialog, setGenerationDialog] = useState<GenerationMode | null>(null);
  const [generationSubmitting, setGenerationSubmitting] = useState(false);
  const [localGeneration, setLocalGeneration] = useState<{
    kind: GenerationMode;
    seen: boolean;
    deadline: number;
    startRevision: ContentPairRevision;
  } | null>(null);
  const [generationStatus, setGenerationStatus] = useState<EditorStatus | null>(null);
  const [initialRetrying, setInitialRetrying] = useState(false);

  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTrigger, setMoveTrigger] = useState<HTMLElement | null>(null);
  const [currentLocation, setCurrentLocation] = useState(location);
  const [currentSource, setCurrentSource] = useState(source);
  const [currentBackHref, setCurrentBackHref] = useState(backHref);
  const [moveMessage, setMoveMessage] = useState<string | null>(null);
  const [currentParticipants, setCurrentParticipants] = useState(() => [...status.review.participants]);

  const confirmedRef = useRef(confirmed);
  const predecessorRevisionRef = useRef<ContentPairRevision | null>(null);
  const latestIncomingRef = useRef(firstIncoming);
  const draftProtectedRef = useRef(false);
  const probedIncomingRef = useRef<string | null>(null);
  const observedParticipantsSignature = useRef(JSON.stringify(status.review.participants));
  const observedGenerationEpochRef = useRef(library?.generationEpoch ?? 0);
  const transcriptEditTriggerRef = useRef<HTMLButtonElement>(null);
  const summaryEditTriggerRef = useRef<HTMLButtonElement>(null);
  const transcriptGenerationTriggerRef = useRef<HTMLButtonElement>(null);
  const summaryGenerationTriggerRef = useRef<HTMLButtonElement>(null);
  const generationCancelRef = useRef<HTMLButtonElement>(null);
  const generationReturnFocusRef = useRef<HTMLElement | null>(null);

  confirmedRef.current = confirmed;
  const incoming = incomingConfirmed(content, transcript, summary);
  latestIncomingRef.current = incoming;
  const incomingSignature = incoming
    ? JSON.stringify({
        revision: incoming.revision,
        transcript: incoming.transcript,
        summary: summaryEditable(incoming.summary),
        transcriptSource: incoming.transcriptSource,
        summarySource: incoming.summarySource,
        summaryOutdated: incoming.summaryOutdated,
      })
    : "";

  const transcriptDirty = confirmed !== null
    && normalizeTranscriptDraft(transcriptDraft) !== confirmed.transcript;
  const summaryDirty = confirmed !== null
    && !sameEditableSummary(summaryDraftToEditable(summaryDraft), summaryEditable(confirmed.summary));
  const activeEditorDirty = editorMode === "transcript" ? transcriptDirty : editorMode === "summary" ? summaryDirty : false;
  const draftProtected = activeEditorDirty || saveStage !== "idle";
  draftProtectedRef.current = draftProtected;

  const externalOperation = status.contentOperation
    ?? (resummarizeInflight ? "summary" : null);
  const effectiveOperation = localGeneration?.kind ?? externalOperation;
  const pairBusy = content?.state === "active";
  const editorLocked = saveStage !== "idle" || saveOutcome === "ambiguous";
  const serverMutationActive = effectiveOperation !== null || pairBusy;
  const canRenderMutationControls = confirmed !== null
    && (content?.state === "stable" || content?.state === "active");
  const canStartMutation = confirmed !== null
    && content?.state === "stable"
    && !serverMutationActive
    && saveStage === "idle";

  useEffect(() => {
    setCurrentLocation(location);
    setCurrentSource(source);
    setCurrentBackHref(backHref);
  }, [backHref, location, source]);

  const incomingParticipantsSignature = JSON.stringify(status.review.participants);
  useEffect(() => {
    if (observedParticipantsSignature.current === incomingParticipantsSignature) return;
    observedParticipantsSignature.current = incomingParticipantsSignature;
    setCurrentParticipants([...status.review.participants]);
  }, [incomingParticipantsSignature, status.review.participants]);

  useEffect(() => {
    if (sourceAccepted || !canonicalDetailHref) return;
    router.replace(canonicalDetailHref);
  }, [canonicalDetailHref, router, sourceAccepted]);

  useEffect(() => {
    const generationEpoch = library?.generationEpoch ?? 0;
    if (observedGenerationEpochRef.current === generationEpoch) return;
    observedGenerationEpochRef.current = generationEpoch;
    setMoveOpen(false);
    setMoveTrigger(null);
    setMoveMessage(null);
    router.refresh();
  }, [library?.generationEpoch, router]);

  useEffect(() => {
    if (attentionAfter) refreshSummaryWork?.(attentionAfter);
  }, [attentionAfter, refreshSummaryWork]);

  // Props may arrive out of order after a local commit. Same revision is safe,
  // predecessor is a late refresh, and a third revision is accepted only after
  // the no-store content resource confirms it is canonical.
  useEffect(() => {
    const candidate = latestIncomingRef.current;
    if (!candidate || !incomingSignature) return;
    const current = confirmedRef.current;
    if (!current) {
      confirmedRef.current = candidate;
      setConfirmed(candidate);
      setTranscriptDraft(candidate.transcript);
      setSummaryDraft(createSummaryEditorDraft(summaryEditable(candidate.summary)));
      return;
    }
    if (sameRevision(candidate.revision, current.revision)) return;
    if (
      predecessorRevisionRef.current
      && sameRevision(candidate.revision, predecessorRevisionRef.current)
    ) return;
    if (draftProtectedRef.current) {
      setExternalSyncStatus({
        kind: "warning",
        message: "다른 내용 변경이 감지됐지만 현재 입력은 그대로 유지했습니다. 저장 전에 최신 상태를 확인하세요.",
      });
      return;
    }
    const revisionKey = JSON.stringify(candidate.revision);
    if (probedIncomingRef.current === revisionKey) return;
    probedIncomingRef.current = revisionKey;
    let cancelled = false;
    setExternalSyncStatus({ kind: "neutral", message: "최신 저장 내용을 확인 중…" });
    void (async () => {
      try {
        const response = await fetch(`/api/meetings/${id}/content`, {
          method: "GET",
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        const resource = response.ok
          ? parseContentResource(await responseBody(response), false)
          : null;
        if (cancelled) return;
        if (resource && sameRevision(resource.revision, candidate.revision)) {
          const next = resourceToConfirmed(resource, candidate.summary);
          predecessorRevisionRef.current = current.revision;
          confirmedRef.current = next;
          setConfirmed(next);
          setTranscriptDraft(next.transcript);
          setSummaryDraft(createSummaryEditorDraft(summaryEditable(next.summary)));
          setExternalSyncStatus({ kind: "success", message: "다른 곳에서 저장된 최신 내용을 반영했습니다." });
        } else {
          setExternalSyncStatus({
            kind: "warning",
            message: "새 내용의 현재 revision을 확인하지 못해 확인된 내용을 유지했습니다.",
          });
        }
      } catch {
        if (!cancelled) {
          setExternalSyncStatus({
            kind: "warning",
            message: "최신 저장 내용을 확인할 수 없어 확인된 내용을 유지했습니다.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftProtected, id, incomingSignature]);

  useEffect(() => {
    if (!effectiveOperation) return;
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [effectiveOperation, router]);

  useEffect(() => {
    if (!localGeneration) return;
    if (externalOperation === localGeneration.kind && !localGeneration.seen) {
      setLocalGeneration({ ...localGeneration, seen: true });
      return;
    }
    if (externalOperation === localGeneration.kind) return;
    const current = confirmedRef.current;
    const revisionChanged = Boolean(
      current && !sameRevision(current.revision, localGeneration.startRevision),
    );
    if (!localGeneration.seen && !revisionChanged) return;
    const failed = localGeneration.kind === "transcript"
      ? status.error?.action === "retry_transcript_generation"
      : status.error?.action === "retry_summary";
    if (failed) {
      setLocalGeneration(null);
      setGenerationStatus({
        kind: "error",
        message: localGeneration.kind === "transcript"
          ? "전체 스크립트를 다시 만들지 못했습니다. 입력과 기존 내용은 유지됐습니다."
          : "회의록 요약을 다시 만들지 못했습니다. 기존 내용은 유지됐습니다.",
      });
      return;
    }
    const completedKind = localGeneration.kind;
    setLocalGeneration(null);
    setGenerationDialog(null);
    setGenerationStatus(null);
    setContentNotice({
      scope: completedKind,
      status: {
        kind: "success",
        message: completedKind === "transcript"
          ? "전체 스크립트를 다시 만들었습니다. 기존 요약은 유지됩니다."
          : "현재 스크립트로 회의록 요약을 다시 만들었습니다.",
      },
    });
    router.refresh();
    window.setTimeout(() => {
      (completedKind === "transcript"
        ? transcriptGenerationTriggerRef.current
        : summaryGenerationTriggerRef.current)?.focus();
    }, 0);
  }, [externalOperation, localGeneration, status.error, router]);

  useEffect(() => {
    if (!localGeneration) return;
    const timer = window.setInterval(() => {
      if (Date.now() <= localGeneration.deadline) return;
      const timedOutKind = localGeneration.kind;
      setLocalGeneration(null);
      setGenerationStatus({
        kind: "error",
        message: timedOutKind === "transcript"
          ? "스크립트 생성이 시간 내에 끝나지 않았습니다. 기존 내용은 유지됐습니다."
          : "요약 생성이 시간 내에 끝나지 않았습니다. 기존 내용은 유지됐습니다.",
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [localGeneration]);

  const focusEditor = () => {
    setFocusRequest((value) => value + 1);
  };

  const resetDraft = (mode: EditorMode, snapshot = confirmedRef.current) => {
    if (!snapshot) return;
    if (mode === "transcript") setTranscriptDraft(snapshot.transcript);
    else setSummaryDraft(createSummaryEditorDraft(summaryEditable(snapshot.summary)));
  };

  const focusEditorTrigger = (mode: EditorMode) => {
    window.setTimeout(() => {
      (mode === "transcript" ? transcriptEditTriggerRef.current : summaryEditTriggerRef.current)?.focus();
    }, 0);
  };

  const commitResource = (
    mode: EditorMode,
    resource: ContentResource,
    before: ConfirmedContent,
  ) => {
    const next = resourceToConfirmed(resource, before.summary);
    predecessorRevisionRef.current = before.revision;
    confirmedRef.current = next;
    setConfirmed(next);
    setTranscriptDraft(next.transcript);
    setSummaryDraft(createSummaryEditorDraft(summaryEditable(next.summary)));
    setSaveStage("idle");
    setSaveOutcome("none");
    setEditorStatus(null);
    setEditorMode(null);
    setLatestConfirming(false);
    setDiscardRequest(null);
    setExternalSyncStatus(null);
    setContentNotice({
      scope: mode,
      status: resource.durability === "pending"
        ? { kind: "warning", message: "저장됨 · 디스크 동기화 확인 대기" }
        : { kind: "success", message: "저장됨" },
    });
    focusEditorTrigger(mode);
  };

  const markAmbiguous = (message: string) => {
    setSaveStage("idle");
    setSaveOutcome("ambiguous");
    setEditorStatus({ kind: "warning", message });
    focusEditor();
  };

  const markConflict = () => {
    setSaveStage("idle");
    setSaveOutcome("conflict");
    setEditorStatus({
      kind: "error",
      message: "다른 변경이 먼저 저장됐습니다. 내 입력을 복사하거나 확인 후 최신 내용을 불러오세요.",
    });
    focusEditor();
  };

  const verifyUnknownSave = async (
    mode: EditorMode,
    intended: string | EditableSummary,
    before: ConfirmedContent,
  ) => {
    setSaveStage("verifying");
    setEditorStatus({ kind: "neutral", message: "저장 여부 확인 중…" });
    try {
      const response = await fetch(`/api/meetings/${id}/content`, {
        method: "GET",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      const resource = response.ok
        ? parseContentResource(await responseBody(response), false)
        : null;
      if (!resource) {
        markAmbiguous("저장 여부를 확인할 수 없습니다. 입력을 유지했으며 저장 요청을 다시 보내지 않았습니다.");
        return;
      }
      if (contentResourceMatches(mode, resource, intended, before)) {
        commitResource(mode, resource, before);
        return;
      }
      if (sameRevision(resource.revision, before.revision)) {
        setSaveStage("idle");
        setSaveOutcome("none");
        setEditorStatus({
          kind: "error",
          message: "저장되지 않은 것을 확인했습니다. 입력을 유지했으니 다시 저장할 수 있습니다.",
        });
        focusEditor();
        return;
      }
      markConflict();
    } catch {
      markAmbiguous("저장 여부를 확인할 수 없습니다. 입력을 유지했으며 저장 요청을 다시 보내지 않았습니다.");
    }
  };

  const handleSaveRefusal = async (response: Response) => {
    const error = publicError(await responseBody(response));
    if (response.status === 400 || response.status === 413 || error?.code === "invalid_request") {
      setSaveStage("idle");
      setEditorStatus({ kind: "error", message: "입력 내용을 확인하세요. 수정 중인 내용은 유지했습니다." });
      focusEditor();
      return;
    }
    if (error?.code === "content_revision_conflict") {
      markConflict();
      return;
    }
    if (error?.code === "content_operation_in_progress") {
      setSaveStage("idle");
      setEditorStatus({
        kind: "warning",
        message: `${operationLabel(error.operation)} 중에는 저장할 수 없습니다. 입력을 유지했으니 작업이 끝난 뒤 다시 시도하세요.`,
      });
      return;
    }
    if (error?.code === "content_source_conflict" || error?.code === "content_state_ambiguous") {
      markAmbiguous("저장 가능한 content pair를 확인할 수 없습니다. 입력을 유지했으니 새로고침하거나 폴더를 확인하세요.");
      return;
    }
    setSaveStage("idle");
    setEditorStatus({ kind: "error", message: "저장하지 못했습니다. 입력을 유지했으니 다시 시도하세요." });
    focusEditor();
  };

  const saveContent = async (mode: EditorMode, intended: string | EditableSummary) => {
    const before = confirmedRef.current;
    if (!before || !canStartMutation || editorLocked || saveOutcome !== "none") return;
    const unchanged = mode === "transcript"
      ? typeof intended === "string" && intended === before.transcript
      : typeof intended !== "string" && sameEditableSummary(intended, summaryEditable(before.summary));
    if (unchanged) {
      resetDraft(mode, before);
      setEditorMode(null);
      setContentNotice({ scope: mode, status: { kind: "neutral", message: "변경 사항이 없습니다." } });
      focusEditorTrigger(mode);
      return;
    }
    setSaveOutcome("none");
    setSaveStage("saving");
    setEditorStatus({ kind: "neutral", message: "저장 중…" });
    const endpoint = mode === "transcript" ? "transcript" : "summary";
    const payload = mode === "transcript"
      ? { expectedRevision: before.revision, transcript: intended }
      : { expectedRevision: before.revision, summary: intended };
    let response: Response;
    try {
      response = await fetch(`/api/meetings/${id}/${endpoint}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      await verifyUnknownSave(mode, intended, before);
      return;
    }
    if (!response.ok) {
      await handleSaveRefusal(response);
      return;
    }
    const resource = parseContentResource(await responseBody(response), true);
    if (!resource || !contentResourceMatches(mode, resource, intended, before)) {
      await verifyUnknownSave(mode, intended, before);
      return;
    }
    commitResource(mode, resource, before);
  };

  const requestEditor = (next: EditorMode) => {
    if (!confirmedRef.current || serverMutationActive || editorLocked) return;
    setContentNotice(null);
    setExternalSyncStatus(null);
    if (!editorMode) {
      resetDraft(next);
      setEditorMode(next);
      setEditorStatus(null);
      setSaveOutcome("none");
      focusEditor();
      return;
    }
    if (editorMode === next) return;
    if (activeEditorDirty) {
      setDiscardRequest({ next });
      return;
    }
    resetDraft(editorMode);
    resetDraft(next);
    setEditorMode(next);
    setEditorStatus(null);
    setSaveOutcome("none");
    focusEditor();
  };

  const requestEditorCancel = () => {
    if (!editorMode || editorLocked) return;
    if (activeEditorDirty) {
      setDiscardRequest({ next: null });
      return;
    }
    resetDraft(editorMode);
    const closed = editorMode;
    setEditorMode(null);
    setEditorStatus(null);
    setSaveOutcome("none");
    focusEditorTrigger(closed);
  };

  const confirmDiscard = () => {
    if (!editorMode || !discardRequest) return;
    const previous = editorMode;
    resetDraft(previous);
    const next = discardRequest.next;
    setDiscardRequest(null);
    setEditorStatus(null);
    setSaveOutcome("none");
    setEditorMode(next);
    if (next) {
      resetDraft(next);
      setTab(next === "transcript" ? "script" : "summary");
      focusEditor();
    }
    else focusEditorTrigger(previous);
  };

  const continueCurrentEdit = () => {
    const current = editorMode;
    setDiscardRequest(null);
    if (!current) return;
    setTab(current === "transcript" ? "script" : "summary");
    focusEditor();
  };

  const loadLatest = async () => {
    const current = confirmedRef.current;
    if (!current) return;
    setSaveStage("verifying");
    setEditorStatus({ kind: "neutral", message: "최신 내용 확인 중…" });
    try {
      const response = await fetch(`/api/meetings/${id}/content`, {
        method: "GET",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      const resource = response.ok
        ? parseContentResource(await responseBody(response), false)
        : null;
      if (!resource) {
        setSaveStage("idle");
        setEditorStatus({ kind: "error", message: "최신 내용을 불러오지 못했습니다. 내 입력은 유지했습니다." });
        setLatestConfirming(false);
        return;
      }
      const mode = editorMode;
      const next = resourceToConfirmed(resource, current.summary);
      predecessorRevisionRef.current = current.revision;
      confirmedRef.current = next;
      setConfirmed(next);
      setTranscriptDraft(next.transcript);
      setSummaryDraft(createSummaryEditorDraft(summaryEditable(next.summary)));
      setSaveStage("idle");
      setSaveOutcome("none");
      setLatestConfirming(false);
      setEditorMode(null);
      setEditorStatus(null);
      if (mode) {
        setContentNotice({ scope: mode, status: { kind: "success", message: "최신 내용을 불러왔습니다." } });
        focusEditorTrigger(mode);
      }
    } catch {
      setSaveStage("idle");
      setEditorStatus({ kind: "error", message: "최신 내용을 불러오지 못했습니다. 내 입력은 유지했습니다." });
      setLatestConfirming(false);
    }
  };

  const openGenerationDialog = (kind: GenerationMode) => {
    if (!canStartMutation || editorMode) return;
    generationReturnFocusRef.current = kind === "transcript"
      ? transcriptGenerationTriggerRef.current
      : summaryGenerationTriggerRef.current;
    setGenerationStatus(null);
    setContentNotice(null);
    setGenerationDialog(kind);
  };

  const beginGeneration = async (kind: GenerationMode) => {
    const current = confirmedRef.current;
    if (!current || generationSubmitting || localGeneration || externalOperation) return;
    setGenerationSubmitting(true);
    setGenerationStatus({
      kind: "neutral",
      message: kind === "transcript" ? "스크립트 생성 요청 중…" : "요약 생성 요청 중…",
    });
    const endpoint = kind === "transcript"
      ? `/api/meetings/${id}/transcript/regenerate`
      : `/api/meetings/${id}/summarize`;
    const body = kind === "transcript"
      ? { expectedRevision: current.revision, confirmReplacement: true }
      : { resummarize: true, expectedRevision: current.revision };
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const responseValue = await responseBody(response);
      const accepted = response.ok
        && response.status === 202
        && isRecord(responseValue)
        && responseValue.ok === true
        && (responseValue.durability === "durable" || responseValue.durability === "best_effort")
        && Object.keys(responseValue).every((key) => key === "ok" || key === "durability");
      if (!accepted) {
        const error = publicError(responseValue);
        setGenerationStatus({
          kind: "error",
          message: error?.code === "content_revision_conflict"
            ? "내용이 바뀌어 시작하지 못했습니다. dialog를 닫고 최신 내용을 확인하세요."
            : error?.code === "content_operation_in_progress"
              ? `${operationLabel(error.operation)} 중이라 시작할 수 없습니다.`
              : "생성 작업을 시작하지 못했습니다. 기존 내용은 유지됐습니다.",
        });
        setGenerationSubmitting(false);
        return;
      }
      setGenerationSubmitting(false);
      setLocalGeneration({
        kind,
        seen: false,
        startRevision: current.revision,
        deadline: Date.now() + (
          kind === "transcript" ? TRANSCRIPT_GENERATION_TIMEOUT_MS : SUMMARY_GENERATION_TIMEOUT_MS
        ),
      });
      setGenerationStatus({
        kind: "neutral",
        message: kind === "transcript" ? "스크립트 만드는 중…" : "요약 만드는 중…",
      });
      router.refresh();
    } catch {
      setGenerationSubmitting(false);
      setGenerationStatus({ kind: "error", message: "생성 요청에 실패했습니다. 기존 내용은 유지됐습니다." });
    }
  };

  const beginInitialSummarize = async () => {
    if (initialRetrying) return;
    setInitialRetrying(true);
    try {
      await fetch(`/api/meetings/${id}/summarize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resummarize: false }),
      });
      setInitialRetrying(false);
      router.refresh();
    } catch {
      setInitialRetrying(false);
    }
  };

  const draftCopyText = editorMode === "transcript"
    ? transcriptDraft
    : JSON.stringify(summaryDraftToEditable(summaryDraft), null, 2);
  const editorSupplemental: ReactNode = (
    <>
      {(saveOutcome === "conflict" || saveOutcome === "ambiguous") && (
        <div className="mt-3 rounded-[12px] border border-line bg-soft p-3">
          <div className="flex flex-wrap gap-2">
            <CopyButton text={draftCopyText} label="내 입력 복사" />
            {saveOutcome === "conflict" && !latestConfirming && (
              <button
                type="button"
                onClick={() => setLatestConfirming(true)}
                className={ACTION_CONTROL_CLASS}
              >
                최신 내용 불러오기
              </button>
            )}
          </div>
          {latestConfirming && (
            <div className="mt-3">
              <p className="text-[13px] text-ink">
                현재 입력을 버리고 서버에서 확인한 최신 내용으로 교체합니다.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={() => void loadLatest()} className={PRIMARY_CONTROL_CLASS}>
                  최신 내용으로 교체
                </button>
                <button
                  type="button"
                  onClick={() => setLatestConfirming(false)}
                  className={ACTION_CONTROL_CLASS}
                >
                  취소
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );

  const mutationReason = saveStage === "saving"
    ? "내용을 저장하는 동안 다른 편집·생성 작업을 시작할 수 없습니다."
    : saveStage === "verifying"
      ? "저장 여부를 확인하는 동안 다른 편집·생성 작업을 시작할 수 없습니다."
      : effectiveOperation
        ? `${effectiveOperation === "transcript" ? "전체 스크립트" : "회의록 요약"} 생성 중에는 다른 내용 작업을 시작할 수 없습니다.`
        : pairBusy
          ? "다른 내용 작업이 진행 중입니다. 완료 후 다시 시도하세요."
          : editorMode
            ? "열린 편집을 저장하거나 취소한 뒤 생성 작업을 시작할 수 있습니다."
            : null;

  const currentTranscript = confirmed?.transcript ?? transcript.text;
  const currentSummary = confirmed?.summary ?? summary;
  const currentSummaryOutdated = confirmed?.summaryOutdated ?? false;
  const currentTranscriptView = {
    text: currentTranscript,
    corrected: confirmed ? true : transcript.corrected,
  };
  const readOnlyWorkNotice = effectiveOperation
    ? "작업 중에도 복사와 다운로드는 현재 저장된 내용을 사용합니다."
    : null;
  const editControlDisabled = serverMutationActive || saveStage !== "idle" || saveOutcome === "ambiguous";
  const generationControlDisabled = !canStartMutation || editorMode !== null || saveOutcome !== "none";
  const safeCombinedExport = confirmed !== null
    && (content?.state === "stable" || content?.state === "active");
  const canMove = library?.mode === "ready" && Boolean(library.version && library.library);
  const hasAttentionNotice = Boolean(attentionAfter && library?.summaryWork);
  const hasLifecycleNotice = Boolean(
    externalOperation === "initial"
    || initialRetrying
    || status.error
    || status.status === "summarizing"
    || status.status === "transcribed",
  );
  const hasNotices = Boolean(moveMessage || hasAttentionNotice || hasLifecycleNotice);
  const statusLabel = effectiveOperation === "transcript"
    ? "전체 스크립트 생성 중"
    : effectiveOperation === "initial" || effectiveOperation === "summary"
      ? "회의록 요약 생성 중"
      : STATUS_LABELS[status.status];
  const scriptFooterStatus = effectiveOperation === "transcript"
    ? "스크립트 만드는 중…"
    : contentNotice?.scope === "transcript"
      ? contentNotice.status.message
      : readOnlyWorkNotice ?? mutationReason;
  const summaryFooterStatus = effectiveOperation === "summary"
    ? "요약 만드는 중…"
    : contentNotice?.scope === "summary"
      ? contentNotice.status.message
      : readOnlyWorkNotice ?? mutationReason;

  const scriptPanel = (
    <div className="space-y-6">
      <ScriptTab transcript={currentTranscriptView} segments={segments} />
      {editorMode === "transcript" && confirmed && (
        <TranscriptEditor
          id={id}
          value={transcriptDraft}
          onChange={(value) => {
            setTranscriptDraft(value);
            setEditorStatus(null);
            setSaveOutcome("none");
          }}
          onSave={(value) => void saveContent("transcript", value)}
          onCancel={requestEditorCancel}
          busy={saveStage !== "idle"}
          saveDisabled={saveOutcome !== "none"}
          cancelDisabled={saveOutcome === "ambiguous"}
          status={editorStatus}
          supplemental={editorSupplemental}
          focusRequest={focusRequest}
        />
      )}
      {currentTranscript.trim() && (
        <footer className="space-y-3 border-t border-line pt-5">
          <div role="group" aria-label="전체 스크립트 작업" className="flex flex-wrap items-center gap-2">
            <CopyButton text={currentTranscript} label="전체 스크립트 복사" />
            {canRenderMutationControls && (
              <>
                <button
                  ref={transcriptEditTriggerRef}
                  type="button"
                  disabled={editControlDisabled}
                  onClick={() => requestEditor("transcript")}
                  className={ACTION_CONTROL_CLASS}
                >
                  전체 스크립트 수정
                </button>
                <button
                  ref={transcriptGenerationTriggerRef}
                  type="button"
                  disabled={generationControlDisabled}
                  onClick={() => openGenerationDialog("transcript")}
                  className={ACTION_CONTROL_CLASS}
                >
                  원문에서 스크립트 다시 만들기
                </button>
              </>
            )}
          </div>
          {scriptFooterStatus && (
            <p role="status" aria-live="polite" className="text-[13px] text-inkSoft">
              {scriptFooterStatus}
            </p>
          )}
        </footer>
      )}
    </div>
  );

  const outdatedHelpId = `summary-outdated-${id}`;
  const summaryPanel = (
    <div className="space-y-6">
      {currentSummaryOutdated && currentSummary && (
        <div
          id={outdatedHelpId}
          role="status"
          className="rounded-[12px] border border-warn/40 bg-warnBg px-4 py-3"
        >
          <p className="text-[13px] font-semibold text-warn">요약 갱신 필요</p>
          <p className="mt-1 text-[13px] text-ink">
            전체 스크립트가 변경되었지만 기존 요약은 유지됨
          </p>
          <p className="mt-1 text-[12px] text-inkSoft">
            회의록 요약을 수정하거나 현재 스크립트로 다시 만들 수 있습니다.
          </p>
        </div>
      )}
      <SummaryTab summary={currentSummary} />
      {editorMode === "summary" && confirmed && (
        <SummaryEditor
          id={id}
          draft={summaryDraft}
          onChange={(value) => {
            setSummaryDraft(value);
            setEditorStatus(null);
            setSaveOutcome("none");
          }}
          onSave={(value) => void saveContent("summary", value)}
          onCancel={requestEditorCancel}
          busy={saveStage !== "idle"}
          saveDisabled={saveOutcome !== "none"}
          cancelDisabled={saveOutcome === "ambiguous"}
          status={editorStatus}
          supplemental={editorSupplemental}
          focusRequest={focusRequest}
        />
      )}
      {currentSummary && (
        <footer className="space-y-3 border-t border-line pt-5">
          <div role="group" aria-label="회의록 요약 작업" className="flex flex-wrap items-center gap-2">
            <CopyButton
              text={formatSummaryMarkdown(currentSummary, currentParticipants, {
                summaryOutdated: currentSummaryOutdated,
              })}
              label="요약 복사"
            />
            <a
              href={`/api/meetings/${id}/export?fmt=json`}
              download
              aria-describedby={currentSummaryOutdated ? outdatedHelpId : undefined}
              title={currentSummaryOutdated ? "현재 저장된 요약 JSON이며 스크립트보다 오래된 내용일 수 있습니다." : undefined}
              className={ACTION_CONTROL_CLASS}
            >
              JSON 다운로드
            </a>
            {canRenderMutationControls && (
              <>
                <button
                  ref={summaryEditTriggerRef}
                  type="button"
                  disabled={editControlDisabled}
                  onClick={() => requestEditor("summary")}
                  className={ACTION_CONTROL_CLASS}
                >
                  회의록 요약 수정
                </button>
                <button
                  ref={summaryGenerationTriggerRef}
                  type="button"
                  disabled={generationControlDisabled}
                  onClick={() => openGenerationDialog("summary")}
                  className={ACTION_CONTROL_CLASS}
                >
                  현재 스크립트로 요약 다시 만들기
                </button>
              </>
            )}
          </div>
          {summaryFooterStatus && (
            <p role="status" aria-live="polite" className="text-[13px] text-inkSoft">
              {summaryFooterStatus}
            </p>
          )}
        </footer>
      )}
    </div>
  );

  const detailTabs: TabItem<"script" | "summary">[] = [
    { value: "script", label: "전체 스크립트", content: scriptPanel },
    {
      value: "summary",
      label: currentSummaryOutdated ? "회의록 요약 · 요약 갱신 필요" : "회의록 요약",
      content: summaryPanel,
    },
  ];

  return (
    <main id="main" className="max-w-5xl space-y-8 px-4 py-12 sm:px-6">
      <header data-detail-section="heading">
        <Link href={currentBackHref} className="inline-flex min-h-11 items-center text-[13px] text-inkSoft hover:text-accent">
          ← 목록
        </Link>
        <div className="mt-3 min-w-0">
          <h1 className="break-words text-2xl font-bold tracking-tight text-ink">{status.title}</h1>
        </div>
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-inkSoft">
          <span className="font-mono text-[12px]">{formatMeetingDate(status.startedAt)}</span>
          <span className="rounded-full bg-soft px-3 py-1 text-[12px] font-medium text-inkSoft">
            {statusLabel}
          </span>
          {currentLocation && library?.library && (
            <span className="min-w-0 break-words">
              위치: {formatLocationBreadcrumb(
                library.library,
                currentLocation.workspaceId,
                currentLocation.folderId,
              ).join(" / ")}
            </span>
          )}
        </div>
      </header>

      <div data-detail-section="notices" className={hasNotices ? "space-y-3" : "hidden"}>
        {moveMessage && (
          <p role="status" aria-live="polite" className="rounded-[12px] border border-success/30 bg-successBg px-4 py-3 text-[13px] text-success">
            {moveMessage}
          </p>
        )}
        {attentionAfter && library?.summaryWork && (
          <div className="flex flex-col items-start gap-2 rounded-[12px] border border-line bg-panel px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center">
            {library.summaryWork.summaryWork.attention ? (
              <Link
                href={`/meetings/${library.summaryWork.summaryWork.attention.meetingId}?attentionAfter=${encodeURIComponent(library.summaryWork.summaryWork.attention.cursor)}`}
                className={ACTION_CONTROL_CLASS}
              >
                다음 확인 필요 회의
              </Link>
            ) : library.summaryWork.summaryWork.needsAttention > 0 ? (
              <button type="button" onClick={() => library.refreshSummaryWork(null)} className={ACTION_CONTROL_CLASS}>
                처음부터 다시 확인
              </button>
            ) : (
              <span className="text-[13px] text-success">확인할 회의를 모두 살펴봤습니다.</span>
            )}
          </div>
        )}
        <StatusCard
          status={status}
          readiness={readiness}
          operation={externalOperation}
          hasStableSummary={confirmed !== null}
          onInitialRetry={() => void beginInitialSummarize()}
          retrying={initialRetrying}
        />
      </div>

      <div data-detail-section="actions" className="space-y-3">
        <div role="group" aria-label="회의 작업" className="flex flex-wrap items-center gap-2">
          {canMove && (
            <button
              type="button"
              onClick={(event) => {
                setMoveTrigger(event.currentTarget);
                setMoveOpen(true);
                setMoveMessage(null);
              }}
              className={ACTION_CONTROL_CLASS}
            >
              회의 이동
            </button>
          )}
          <RevealButton id={id} />
          {safeCombinedExport && (
            <a href={`/api/meetings/${id}/export?fmt=md`} download className={ACTION_CONTROL_CLASS}>
              회의록 다운로드(.md)
            </a>
          )}
        </div>
        {moveOpen && (
          <LibraryLocationPicker
            kind="meeting"
            meetingId={id}
            current={currentLocation}
            trigger={moveTrigger}
            onClose={() => setMoveOpen(false)}
            onMoved={(actual) => {
              const fallbackSource = currentSource ?? (actual.folderId === null
                ? { kind: "unfiled" as const, workspaceId: actual.workspaceId }
                : { kind: "folder" as const, workspaceId: actual.workspaceId, folderId: actual.folderId });
              const next = resolvePostMoveDetailSource({
                meetingId: id,
                source: fallbackSource,
                actual,
                attentionAfter,
              });
              setCurrentLocation(actual);
              setCurrentSource(next.source);
              setCurrentBackHref(next.backHref);
              setMoveMessage(next.sourceChanged
                ? "회의를 이동해 목록 기준도 실제 저장 위치로 바꿨습니다."
                : "회의를 이동했습니다. 현재 목록에서도 계속 볼 수 있습니다.");
              const commit = () => router.replace(next.detailHref);
              if (recorderSession) recorderSession.requestNavigation(next.detailHref, commit);
              else commit();
            }}
          />
        )}
      </div>

      <section
        data-detail-section="meeting-info"
        aria-labelledby={`meeting-info-${id}`}
        className="space-y-3"
      >
        <h2 id={`meeting-info-${id}`} className="text-[16px] font-bold text-ink">회의 정보</h2>
        <div className={hasAudio ? "grid gap-4 lg:grid-cols-2 lg:items-start" : "max-w-2xl"}>
          {hasAudio && (
            <div className="rounded-[16px] border border-line bg-panel p-4 sm:p-5">
              <h3 className="text-[14px] font-bold text-ink">녹음 재생</h3>
              <audio controls preload="metadata" src={`/api/meetings/${id}/audio`} className="mt-3 w-full" />
            </div>
          )}
          <ReviewForm
            id={id}
            participants={currentParticipants}
            onSaved={(next) => setCurrentParticipants([...next])}
          />
        </div>
      </section>

      <section data-detail-section="tabs" aria-label="회의 내용">
        {content && ["ambiguous", "source_conflict", "interrupted"].includes(content.state) && (
          <div className="mb-4 rounded-[12px] border border-warn/40 bg-warnBg px-4 py-3">
            <p className="text-[13px] text-ink">
              안전한 transcript·summary pair를 확인할 수 없어 수정과 재생성을 잠갔습니다. 새로고침하거나 폴더의 파일을 확인하세요.
            </p>
            <button type="button" onClick={() => router.refresh()} className={`${ACTION_CONTROL_CLASS} mt-2`}>
              새로고침
            </button>
          </div>
        )}
        {externalSyncStatus && (
          <p
            role="status"
            aria-live="polite"
            className={`mb-4 rounded-[12px] border px-4 py-3 text-[13px] ${
              externalSyncStatus.kind === "warning"
                ? "border-warn/40 bg-warnBg text-warn"
                : externalSyncStatus.kind === "success"
                  ? "border-success/30 bg-successBg text-success"
                  : "border-line bg-panel text-inkSoft"
            }`}
          >
            {externalSyncStatus.message}
          </p>
        )}
        {discardRequest && (
          <div className="mb-4 rounded-[12px] border border-warn/40 bg-warnBg p-3">
            <p className="text-[13px] text-ink">저장하지 않은 수정 내용을 버릴까요?</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={confirmDiscard} className={PRIMARY_CONTROL_CLASS}>
                수정 내용 버리기
              </button>
              <button type="button" onClick={continueCurrentEdit} className={ACTION_CONTROL_CLASS}>
                계속 수정
              </button>
            </div>
          </div>
        )}
        <Tabs<"script" | "summary">
          id={`meeting-${id}-content`}
          ariaLabel="회의 내용"
          items={detailTabs}
          value={tab}
          onValueChange={setTab}
        />
      </section>

      <AppDialog
        open={generationDialog !== null}
        title={generationDialog === "transcript" ? "전체 스크립트 다시 만들기" : "회의록 요약 다시 만들기"}
        onDismiss={() => {
          setGenerationDialog(null);
          setGenerationStatus(null);
        }}
        initialFocusRef={generationCancelRef}
        returnFocus={generationReturnFocusRef.current}
        dismissible={!generationSubmitting && localGeneration === null}
      >
        <div className="mt-4 space-y-4">
          <p className="text-[14px] leading-relaxed text-ink">
            {generationDialog === "transcript"
              ? "자동 전사 원문에서 교정된 전체 스크립트를 다시 만듭니다. 현재 스크립트는 대체되고 기존 요약은 유지되지만 요약 갱신이 필요할 수 있습니다."
              : "현재 저장된 전체 스크립트로 회의록 요약만 다시 만듭니다. 스크립트는 바뀌지 않고 현재 수동 요약은 대체됩니다."}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              ref={generationCancelRef}
              type="button"
              disabled={generationSubmitting || localGeneration !== null}
              onClick={() => {
                setGenerationDialog(null);
                setGenerationStatus(null);
              }}
              className={ACTION_CONTROL_CLASS}
            >
              취소
            </button>
            <button
              type="button"
              disabled={generationSubmitting || localGeneration !== null || generationDialog === null}
              onClick={() => generationDialog && void beginGeneration(generationDialog)}
              className={PRIMARY_CONTROL_CLASS}
            >
              {generationDialog === "transcript" ? "스크립트 다시 만들기" : "요약 다시 만들기"}
            </button>
          </div>
          <p role="status" aria-live="polite" className={`min-h-5 text-[13px] ${generationStatus?.kind === "error" ? "text-error" : "text-inkSoft"}`}>
            {generationStatus?.message ?? ""}
          </p>
        </div>
      </AppDialog>
    </main>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      {title && <h3 className="text-[14px] font-bold text-ink">{title}</h3>}
      <ul className="mt-2 space-y-1.5">
        {items.map((item, index) => (
          <li key={index} className="flex gap-2 text-[14px] leading-relaxed text-inkSoft">
            <span aria-hidden="true" className="text-inkSoft">•</span>
            <span className="whitespace-pre-wrap break-words">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent motion-reduce:animate-none"
      aria-hidden="true"
    />
  );
}

function StatusCard({
  status,
  readiness,
  operation,
  hasStableSummary,
  onInitialRetry,
  retrying,
}: {
  status: MeetingDetailStatus;
  readiness: LlmReadiness;
  operation: "initial" | "transcript" | "summary" | null;
  hasStableSummary: boolean;
  onInitialRetry(): void;
  retrying: boolean;
}) {
  if (operation === "initial" || (status.status === "summarizing" && !hasStableSummary)) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-line bg-panel px-4 py-4 sm:px-5">
        <Spinner />
        <p className="text-[14px] text-ink">요약 생성 중…</p>
      </div>
    );
  }

  if (status.error?.action === "retry_transcript_generation") {
    return (
      <div className="rounded-[12px] border border-error/40 bg-error/10 px-4 py-4 sm:px-5">
        <p className="text-[14px] text-ink">
          <span className="font-semibold text-error">전체 스크립트 생성 실패</span>
          {" — "}{status.error.message}
        </p>
        <p className="mt-1 text-[13px] text-inkSoft">전체 스크립트 탭 하단에서 다시 시도할 수 있습니다.</p>
      </div>
    );
  }

  if (status.error?.action === "retry_summary") {
    if (hasStableSummary) {
      return (
        <div className="rounded-[12px] border border-error/40 bg-error/10 px-4 py-4 sm:px-5">
          <p className="text-[14px] text-ink">
            <span className="font-semibold text-error">회의록 요약 생성 실패</span>
            {" — "}{status.error.message}
          </p>
          <p className="mt-1 text-[13px] text-inkSoft">회의록 요약 탭 하단에서 다시 시도할 수 있습니다.</p>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-start gap-3 rounded-[12px] border border-error/40 bg-error/10 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <p className="min-w-0 break-words text-[14px] text-ink">
          <span className="font-semibold text-error">요약 실패</span> — {status.error.message}
        </p>
        <button
          type="button"
          onClick={onInitialRetry}
          disabled={retrying}
          className={PRIMARY_CONTROL_CLASS}
        >
          {retrying ? "재시도 중…" : "재시도"}
        </button>
      </div>
    );
  }

  if (status.status === "transcribed") {
    if (readiness === "unconfigured" || readiness === "unavailable") {
      const unavailable = readiness === "unavailable";
      return (
        <div className={`flex flex-col items-start gap-3 rounded-[12px] border px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5 ${
          unavailable ? "border-error/40 bg-error/5" : "border-warn/40 bg-warnBg"
        }`}>
          <p className="text-[14px] text-ink">
            {unavailable
              ? "요약 모델을 확인하세요. 설정한 모델이 지금 사용할 수 없습니다."
              : "요약하려면 모델을 설정하세요."}
          </p>
          <Link href="/settings" className={ACTION_CONTROL_CLASS}>설정</Link>
        </div>
      );
    }
    if (readiness === "loading") {
      return (
        <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-line bg-panel px-4 py-4 sm:px-5">
          <Spinner />
          <p className="text-[14px] text-ink">요약 모델 확인 중…</p>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-line bg-panel px-4 py-4 sm:px-5">
        <span
          className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
          aria-hidden="true"
        />
        <p className="text-[14px] text-ink">요약 대기 · 자동 생성 중…</p>
      </div>
    );
  }

  return null;
}

function RevealButton({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "pending" | "requested" | "error">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const showResult = (next: "requested" | "error") => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setState(next);
    resetTimer.current = setTimeout(() => {
      resetTimer.current = null;
      setState("idle");
    }, next === "error" ? 3000 : 1500);
  };

  const open = async () => {
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
    setState("pending");
    try {
      const response = await fetch(`/api/meetings/${id}/reveal`, { method: "POST" });
      if (!response.ok) throw new Error("reveal request refused");
      showResult("requested");
    } catch {
      showResult("error");
    }
  };

  const label = state === "pending"
    ? "여는 중…"
    : state === "requested"
      ? "열기 요청됨"
      : state === "error"
        ? "열기 실패"
        : "폴더 열기";

  return (
    <button
      type="button"
      onClick={() => void open()}
      disabled={state === "pending"}
      className={ACTION_CONTROL_CLASS}
    >
      <span aria-live="polite" aria-atomic="true">{label}</span>
    </button>
  );
}

function ScriptTab({
  transcript,
  segments,
}: {
  transcript: MeetingDetailData["transcript"];
  segments: Segment[];
}) {
  if (!transcript.text.trim()) {
    return <p className="text-[14px] text-inkSoft">아직 전사가 없습니다.</p>;
  }
  const showSegments = !transcript.corrected && segments.length > 0;
  return (
    <div className="space-y-4">
      {!transcript.corrected && (
        <p className="rounded-md bg-warnBg px-3 py-2 text-[13px] text-warn">교정 전 원문 · 자동 전사</p>
      )}
      {showSegments ? (
        <ul className="space-y-2">
          {segments.map((segment, index) => (
            <li key={index} className="flex gap-3 text-[14px] leading-relaxed">
              <span className="shrink-0 font-mono text-[12px] text-inkSoft">
                {formatDuration(segment.start * 1000)}
              </span>
              <span className="whitespace-pre-wrap break-words text-ink">{segment.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink">
          {transcript.text}
        </div>
      )}
    </div>
  );
}

function SummaryTab({ summary }: { summary: Summary | null }) {
  if (!summary) return <p className="text-[14px] text-inkSoft">아직 요약이 없습니다.</p>;
  const actionLines = summary.actionItems.map((item) => (
    `${item.owner} — ${item.task} (기한: ${item.due})`
  ));
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-[14px] font-bold text-ink">요약</h3>
        <p className="mt-2 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink">{summary.oneLine}</p>
        <Section title="" items={summary.highlights} />
      </div>
      {summary.purpose && (
        <div>
          <h3 className="text-[14px] font-bold text-ink">목적</h3>
          <p className="mt-2 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-inkSoft">{summary.purpose}</p>
        </div>
      )}
      <Section title="논의 내용" items={summary.discussion} />
      <Section title="결정 사항" items={summary.decisions} />
      <Section title="액션 아이템" items={actionLines} />
      <Section title="리스크" items={summary.risks} />
      <Section title="후속 확인" items={summary.followups} />
    </div>
  );
}

function ReviewForm({
  id,
  participants,
  onSaved,
}: {
  id: string;
  participants: string[];
  onSaved(participants: string[]): void;
}) {
  const externalText = participants.join(", ");
  const [draft, setDraft] = useState(externalText);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (dirty) return;
    setDraft(externalText);
  }, [dirty, externalText]);

  const toList = (value: string) => value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/meetings/${id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ participants: toList(draft) }),
      });
      if (!response.ok) throw new Error("review save refused");
      const body: unknown = await response.json();
      if (
        !isRecord(body)
        || !isRecord(body.review)
        || !Array.isArray(body.review.participants)
        || !body.review.participants.every((value) => typeof value === "string")
      ) throw new Error("invalid review response");
      const normalized = toList(body.review.participants.join(","));
      setDraft(normalized.join(", "));
      setDirty(false);
      setFeedback({ kind: "success", text: "저장됨" });
      onSaved(normalized);
    } catch {
      setFeedback({ kind: "error", text: "참석자를 저장하지 못했습니다. 입력을 유지했으니 다시 시도하세요." });
    } finally {
      setSaving(false);
    }
  };

  const inputId = `participants-${id}`;
  const helpId = `participants-help-${id}`;
  const statusId = `participants-status-${id}`;
  return (
    <form
      onSubmit={(event) => void submit(event)}
      aria-labelledby={`participants-heading-${id}`}
      className="rounded-[16px] border border-line bg-panel p-4 sm:p-5"
    >
      <h3 id={`participants-heading-${id}`} className="text-[16px] font-bold text-ink">참석자</h3>
      <p id={helpId} className="mt-1 text-[13px] text-inkSoft">
        쉼표로 구분해 입력하세요. 참석자는 이 입력이 유일한 출처입니다.
      </p>
      <label htmlFor={inputId} className="mt-4 block text-[13px] font-medium text-inkSoft">참석자</label>
      <input
        id={inputId}
        className="mt-1 min-h-11 w-full rounded-md border border-line bg-panel px-3 py-2 text-[14px] text-ink placeholder:text-inkSoft focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          setDirty(next !== externalText);
          setFeedback(null);
        }}
        aria-describedby={`${helpId} ${statusId}`}
        placeholder="예: 딜런, 지훈"
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={saving} className={PRIMARY_CONTROL_CLASS}>
          {saving ? "저장 중…" : "저장"}
        </button>
        <p
          id={statusId}
          role="status"
          aria-live="polite"
          className={`min-w-0 text-[13px] ${feedback?.kind === "error" ? "text-error" : "text-success"}`}
        >
          {saving ? "저장 중…" : feedback?.text ?? ""}
        </p>
      </div>
    </form>
  );
}
