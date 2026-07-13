import { z } from "zod";

import { MEETING_STATUSES } from "@/domain/meeting";

export const CHAT_REQUEST_LIMITS = {
  messageChars: 4_000,
  historyItems: 8,
  historyItemChars: 8_000,
  historyTotalChars: 24_000,
} as const;

export const CHAT_RESULT_LIMITS = {
  knowledgeCardChars: 8_000,
  summaryChars: 20_000,
  transcriptWindowChars: 4_000,
  fullTranscriptChars: 60_000,
} as const;

export const CHAT_BUDGETS = {
  normal: {
    modelTurns: 4,
    toolCalls: 6,
    knowledgeCards: 50,
    summaries: 8,
    transcriptWindows: 12,
    fullTranscripts: 2,
    transcriptScans: 40,
    aggregateToolOutputChars: 120_000,
  },
  deep: {
    modelTurns: 6,
    toolCalls: 10,
    knowledgeCards: 100,
    summaries: 16,
    transcriptWindows: 24,
    fullTranscripts: 4,
    transcriptScans: 80,
    aggregateToolOutputChars: 240_000,
  },
} as const;

export const CHAT_TOOL_NAMES = [
  "get_user_profile",
  "search_meetings",
  "search_transcripts",
  "read_knowledge_cards",
  "read_summaries",
  "read_transcript_chunks",
  "read_full_transcript",
] as const;

export const CHAT_WARNING_CODES = [
  "index_partial",
  "candidate_limit_reached",
  "stale_evidence",
  "truncated_evidence",
  "budget_exhausted",
  "unsupported_claim_omitted",
  "personalization_needed",
  "profile_unavailable",
  "history_reference_ambiguous",
] as const;

export const CHAT_TOOL_ERROR_CODES = [
  "unknown_tool",
  "invalid_arguments",
  "invalid_meeting_id",
  "duplicate_meeting_id",
  "budget_exhausted",
  "aggregate_budget_exhausted",
  "profile_unavailable",
  "index_unavailable",
  "search_retry",
  "meeting_deleted",
  "delete_state_ambiguous",
  "artifact_missing",
  "artifact_unavailable",
  "card_stale",
  "card_corrupt",
  "invalid_cursor",
  "transcript_too_large",
] as const;

const safeMeetingIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);

function characterLength(value: string): number {
  return Array.from(value).length;
}

function charBoundedString(maximum: number) {
  return z.string().refine((value) => characterLength(value) <= maximum, {
    message: `must contain at most ${maximum} characters`,
  });
}

const nonEmptyMessageSchema = charBoundedString(CHAT_REQUEST_LIMITS.messageChars)
  .refine((value) => value.trim().length > 0, "message must not be blank");
const historyContentSchema = charBoundedString(CHAT_REQUEST_LIMITS.historyItemChars);

export const chatHistoryReferenceSchema = z.object({
  number: z.number().int().min(1).max(20),
  meetingId: safeMeetingIdSchema,
}).strict();

const chatHistoryReferenceMapSchema = z.array(chatHistoryReferenceSchema)
  .max(20)
  .superRefine((items, context) => {
    const numbers = new Set<number>();
    const meetingIds = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (numbers.has(item.number)) {
        context.addIssue({ code: "custom", path: [index, "number"], message: "duplicate reference number" });
      }
      if (meetingIds.has(item.meetingId)) {
        context.addIssue({ code: "custom", path: [index, "meetingId"], message: "duplicate meeting ID" });
      }
      numbers.add(item.number);
      meetingIds.add(item.meetingId);
    }
  });

export const chatHistoryItemSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    content: historyContentSchema,
  }).strict(),
  z.object({
    role: z.literal("assistant"),
    content: historyContentSchema,
    referenceMap: chatHistoryReferenceMapSchema.optional(),
  }).strict(),
]);

const chatHistorySchema = z.array(chatHistoryItemSchema)
  .max(CHAT_REQUEST_LIMITS.historyItems)
  .superRefine((items, context) => {
    if (items.length % 2 !== 0) {
      context.addIssue({ code: "custom", message: "history must contain complete turns" });
    }
    for (let index = 0; index < items.length; index += 1) {
      const expected = index % 2 === 0 ? "user" : "assistant";
      if (items[index]?.role !== expected) {
        context.addIssue({ code: "custom", path: [index, "role"], message: `expected ${expected}` });
      }
    }
    const total = items.reduce((sum, item) => sum + characterLength(item.content), 0);
    if (total > CHAT_REQUEST_LIMITS.historyTotalChars) {
      context.addIssue({ code: "custom", message: "history text budget exceeded" });
    }
  });

export const chatRequestSchema = z.object({
  message: nonEmptyMessageSchema,
  mode: z.enum(["normal", "deep"]),
  history: chatHistorySchema.optional(),
}).strict();

const calendarDateSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, "invalid calendar date");

export const chatSearchFiltersSchema = z.object({
  dateFrom: calendarDateSchema.optional(),
  dateTo: calendarDateSchema.optional(),
  workspaceId: z.string().min(1).max(128).optional(),
  folderId: z.union([z.string().min(1).max(128), z.null()]).optional(),
  status: z.enum(MEETING_STATUSES).optional(),
  hasActionItem: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) {
    context.addIssue({ code: "custom", path: ["dateTo"], message: "invalid date range" });
  }
});

const callIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
const meetingIdsSchema = z.array(safeMeetingIdSchema).min(1).max(CHAT_BUDGETS.deep.knowledgeCards);

const getUserProfileCallSchema = z.object({
  callId: callIdSchema,
  name: z.literal("get_user_profile"),
  arguments: z.object({}).strict(),
}).strict();

const searchMeetingsCallSchema = z.object({
  callId: callIdSchema,
  name: z.literal("search_meetings"),
  arguments: z.object({
    query: z.string().min(1).max(500),
    filters: chatSearchFiltersSchema.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }).strict(),
}).strict();

const searchTranscriptsCallSchema = z.object({
  callId: callIdSchema,
  name: z.literal("search_transcripts"),
  arguments: z.object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(20).optional(),
  }).strict(),
}).strict();

const readKnowledgeCardsCallSchema = z.object({
  callId: callIdSchema,
  name: z.literal("read_knowledge_cards"),
  arguments: z.object({ meetingIds: meetingIdsSchema }).strict(),
}).strict();

const readSummariesCallSchema = z.object({
  callId: callIdSchema,
  name: z.literal("read_summaries"),
  arguments: z.object({ meetingIds: z.array(safeMeetingIdSchema).min(1).max(CHAT_BUDGETS.deep.summaries) }).strict(),
}).strict();

const readTranscriptChunksCallSchema = z.object({
  callId: callIdSchema,
  name: z.literal("read_transcript_chunks"),
  arguments: z.object({
    meetingId: safeMeetingIdSchema,
    query: z.string().min(1).max(500),
    cursor: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(CHAT_BUDGETS.deep.transcriptWindows).optional(),
  }).strict(),
}).strict();

const readFullTranscriptCallSchema = z.object({
  callId: callIdSchema,
  name: z.literal("read_full_transcript"),
  arguments: z.object({ meetingId: safeMeetingIdSchema }).strict(),
}).strict();

export const chatToolCallSchema = z.discriminatedUnion("name", [
  getUserProfileCallSchema,
  searchMeetingsCallSchema,
  searchTranscriptsCallSchema,
  readKnowledgeCardsCallSchema,
  readSummariesCallSchema,
  readTranscriptChunksCallSchema,
  readFullTranscriptCallSchema,
]);

export const chatToolResultSchema = z.discriminatedUnion("status", [
  z.object({
    callId: callIdSchema,
    name: z.enum(CHAT_TOOL_NAMES),
    status: z.literal("ok"),
    data: z.unknown(),
    truncated: z.boolean(),
    budgetExhausted: z.boolean(),
  }).strict(),
  z.object({
    callId: callIdSchema,
    name: z.enum(CHAT_TOOL_NAMES),
    status: z.literal("error"),
    error: z.object({
      code: z.enum(CHAT_TOOL_ERROR_CODES),
      message: z.string().min(1).max(200),
    }).strict(),
    truncated: z.boolean(),
    budgetExhausted: z.boolean(),
  }).strict(),
]);

function safeModelText(value: string): boolean {
  return !/\[[0-9]{1,2}(?:\s*,\s*[0-9]{1,2})*\]/u.test(value)
    && !/https?:\/\/|\/meetings\//iu.test(value)
    && !/[\r\n]/u.test(value);
}

const modelSegmentTextSchema = charBoundedString(500)
  .min(1)
  .refine(safeModelText, "model answer text must not contain numbering or links");

const modelAnswerSegmentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("claim"),
    format: z.enum(["paragraph", "bullet"]),
    text: modelSegmentTextSchema,
    citationMeetingIds: z.array(safeMeetingIdSchema).min(1).max(5),
  }).strict(),
  z.object({
    kind: z.enum(["clarification", "limitation"]),
    format: z.enum(["paragraph", "bullet"]),
    text: modelSegmentTextSchema,
    citationMeetingIds: z.array(z.never()).max(0),
  }).strict(),
]);

const limitationFlagSchema = z.enum([
  "evidence_missing",
  "profile_needed",
  "index_partial",
  "budget_exhausted",
  "unsupported_claims",
]);

const toolCallsEnvelopeSchema = z.object({
  type: z.literal("tool_calls"),
  toolCalls: z.array(chatToolCallSchema).min(1).max(CHAT_BUDGETS.deep.toolCalls),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, call] of value.toolCalls.entries()) {
    if (ids.has(call.callId)) {
      context.addIssue({ code: "custom", path: ["toolCalls", index, "callId"], message: "duplicate call ID" });
    }
    ids.add(call.callId);
  }
});

const finalEnvelopeSchema = z.object({
  type: z.literal("final"),
  answerSegments: z.array(modelAnswerSegmentSchema).max(40),
  limitationFlags: z.array(limitationFlagSchema).max(5),
}).strict().superRefine((value, context) => {
  const nonClaims = value.answerSegments.filter((segment) => segment.kind !== "claim");
  if (nonClaims.length > 2) {
    context.addIssue({ code: "custom", path: ["answerSegments"], message: "too many non-claim segments" });
  }
  const total = value.answerSegments.reduce((sum, segment) => sum + characterLength(segment.text), 0);
  if (total > 8_000) {
    context.addIssue({ code: "custom", path: ["answerSegments"], message: "answer text budget exceeded" });
  }
  const meetings = new Set(value.answerSegments.flatMap((segment) => (
    segment.kind === "claim" ? segment.citationMeetingIds : []
  )));
  if (meetings.size > 20) {
    context.addIssue({ code: "custom", path: ["answerSegments"], message: "too many cited meetings" });
  }
  if (new Set(value.limitationFlags).size !== value.limitationFlags.length) {
    context.addIssue({ code: "custom", path: ["limitationFlags"], message: "duplicate limitation flag" });
  }
});

export const modelChatEnvelopeSchema = z.discriminatedUnion("type", [
  toolCallsEnvelopeSchema,
  finalEnvelopeSchema,
]);

const publicAnswerSegmentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("claim"),
    format: z.enum(["paragraph", "bullet"]),
    text: modelSegmentTextSchema,
    referenceNumbers: z.array(z.number().int().min(1).max(20)).min(1).max(5),
  }).strict(),
  z.object({
    kind: z.enum(["clarification", "limitation"]),
    format: z.enum(["paragraph", "bullet"]),
    text: modelSegmentTextSchema,
    referenceNumbers: z.array(z.never()).max(0),
  }).strict(),
]);

const publicReferenceSchema = z.object({
  number: z.number().int().min(1).max(20),
  meetingId: safeMeetingIdSchema,
  currentTitle: z.string().max(500),
  startedAt: z.string().datetime({ offset: true }),
  href: z.string(),
}).strict().superRefine((value, context) => {
  if (value.href !== `/meetings/${value.meetingId}`) {
    context.addIssue({ code: "custom", path: ["href"], message: "reference href must be server derived" });
  }
});

const checkedScopeSchema = z.object({
  searchResults: z.number().int().min(0).max(100),
  knowledgeCards: z.number().int().min(0).max(CHAT_BUDGETS.deep.knowledgeCards),
  summaries: z.number().int().min(0).max(CHAT_BUDGETS.deep.summaries),
  transcriptWindows: z.number().int().min(0).max(CHAT_BUDGETS.deep.transcriptWindows),
  fullTranscripts: z.number().int().min(0).max(CHAT_BUDGETS.deep.fullTranscripts),
  distinctMeetings: z.number().int().min(0).max(100),
}).strict();

const searchReplaySchema = z.object({
  query: z.string().min(1).max(500),
  filters: chatSearchFiltersSchema,
  limit: z.number().int().min(1).max(50),
  resultCount: z.number().int().min(0).max(50),
}).strict();

export const chatResponseSchema = z.object({
  answerSegments: z.array(publicAnswerSegmentSchema).min(1).max(40),
  references: z.array(publicReferenceSchema).max(20),
  evidenceStatus: z.enum(["sufficient", "partial", "none"]),
  checkedScope: checkedScopeSchema,
  warnings: z.array(z.enum(CHAT_WARNING_CODES)).max(CHAT_WARNING_CODES.length),
  searchReplay: searchReplaySchema.optional(),
}).strict().superRefine((value, context) => {
  const referenceIds = new Set<string>();
  for (const [index, reference] of value.references.entries()) {
    if (reference.number !== index + 1) {
      context.addIssue({ code: "custom", path: ["references", index, "number"], message: "references must be contiguous" });
    }
    if (referenceIds.has(reference.meetingId)) {
      context.addIssue({ code: "custom", path: ["references", index, "meetingId"], message: "duplicate meeting reference" });
    }
    referenceIds.add(reference.meetingId);
  }

  const knownNumbers = new Set(value.references.map((reference) => reference.number));
  const firstAppearance: number[] = [];
  const used = new Set<number>();
  for (const [segmentIndex, segment] of value.answerSegments.entries()) {
    if (segment.kind !== "claim") continue;
    if (new Set(segment.referenceNumbers).size !== segment.referenceNumbers.length) {
      context.addIssue({ code: "custom", path: ["answerSegments", segmentIndex, "referenceNumbers"], message: "duplicate claim reference" });
    }
    for (const number of segment.referenceNumbers) {
      if (!knownNumbers.has(number)) {
        context.addIssue({ code: "custom", path: ["answerSegments", segmentIndex, "referenceNumbers"], message: "unknown claim reference" });
      }
      if (!used.has(number)) {
        used.add(number);
        firstAppearance.push(number);
      }
    }
  }
  if (used.size !== value.references.length) {
    context.addIssue({ code: "custom", path: ["references"], message: "unused reference" });
  }
  if (!firstAppearance.every((number, index) => number === index + 1)) {
    context.addIssue({ code: "custom", path: ["references"], message: "reference order must follow first claim appearance" });
  }
  if (new Set(value.warnings).size !== value.warnings.length) {
    context.addIssue({ code: "custom", path: ["warnings"], message: "duplicate warning" });
  }
  const hasClaim = value.answerSegments.some((segment) => segment.kind === "claim");
  if (value.evidenceStatus === "none" && (hasClaim || value.references.length > 0)) {
    context.addIssue({ code: "custom", path: ["evidenceStatus"], message: "no evidence cannot publish claims" });
  }
  if (value.evidenceStatus !== "none" && !hasClaim) {
    context.addIssue({ code: "custom", path: ["evidenceStatus"], message: "evidence status requires a claim" });
  }
});

export type ChatMode = keyof typeof CHAT_BUDGETS;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ChatHistoryItem = z.infer<typeof chatHistoryItemSchema>;
export type ChatToolName = typeof CHAT_TOOL_NAMES[number];
export type ChatToolCall = z.infer<typeof chatToolCallSchema>;
export type ChatToolResult = z.infer<typeof chatToolResultSchema>;
export type ModelChatEnvelope = z.infer<typeof modelChatEnvelopeSchema>;
export type ModelAnswerSegment = z.infer<typeof modelAnswerSegmentSchema>;
export type ChatWarning = typeof CHAT_WARNING_CODES[number];
export type ChatToolErrorCode = typeof CHAT_TOOL_ERROR_CODES[number];
export type ChatResponse = z.infer<typeof chatResponseSchema>;
export type ChatSearchFilters = z.infer<typeof chatSearchFiltersSchema>;
