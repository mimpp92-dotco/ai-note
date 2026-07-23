import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const stringList = z.array(z.string());

export const actionItemSearchMetadataSchema = z.object({
  owner: z.string(),
  task: z.string(),
  due: z.string(),
  searchText: z.string(),
}).strict();

export const knowledgeCardSchema = z.object({
  schemaVersion: z.literal(1),
  meetingId: z.string().min(1),
  sourceHashes: z.object({ summary: sha256Schema, transcript: sha256Schema }).strict(),
  content: z.object({
    oneLine: z.string(), purpose: z.string(), highlights: stringList,
    discussion: stringList, decisions: stringList, risks: stringList, followups: stringList,
    body: z.string().optional(),
  }).strict(),
  actionItems: z.array(actionItemSearchMetadataSchema),
  reviewParticipants: stringList,
  mentionedPeople: stringList,
}).strict();

export const corpusCardProjectionSchema = z.object({
  meetingId: z.string().min(1),
  oneLine: z.string(),
  purpose: z.string(),
  highlights: stringList,
  mentionedPeople: stringList,
  body: z.string().optional(),
}).strict();

export const corpusMapSchema = z.object({
  schemaVersion: z.literal(1),
  cards: z.array(corpusCardProjectionSchema),
}).strict();

export const KNOWLEDGE_INDEX_READ_MODES = ["missing", "ready", "stale", "corrupt", "io_error"] as const;
export const KNOWLEDGE_INDEX_STATES = ["ready", "partial", "unavailable"] as const;
export const KNOWLEDGE_INDEX_REASONS = ["missing", "stale", "corrupt", "io_error"] as const;

export const knowledgeIndexStatusSchema = z.object({
  internalMode: z.enum(KNOWLEDGE_INDEX_READ_MODES),
  state: z.enum(KNOWLEDGE_INDEX_STATES),
  reason: z.enum(KNOWLEDGE_INDEX_REASONS).optional(),
}).strict().superRefine((value, context) => {
  if (value.state === "ready" && (value.internalMode !== "ready" || value.reason !== undefined)) {
    context.addIssue({ code: "custom", message: "ready state requires ready internal mode and no reason" });
  }
  if (value.state !== "ready" && value.reason === undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "non-ready state requires a safe reason" });
  }
});

export type KnowledgeCard = z.infer<typeof knowledgeCardSchema>;
export type CorpusMap = z.infer<typeof corpusMapSchema>;
export type KnowledgeIndexStatus = z.infer<typeof knowledgeIndexStatusSchema>;

const OWNER_PLACEHOLDERS = new Set([
  "todo",
  "tbd",
  "unknown",
  "-",
  "미정",
  "미지정",
  "담당자",
  "없음",
  "n/a",
]);

export function deriveMentionedPeople(items: Array<{ owner: string; task: string; due: string; searchText?: string }>): string[] {
  return [...new Set(items.map(({ owner }) => owner.trim()).filter((owner) => owner !== "" && !OWNER_PLACEHOLDERS.has(owner.toLocaleLowerCase())) )];
}
