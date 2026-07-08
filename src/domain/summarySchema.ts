import { z } from "zod";

// summary.json contract (정본: docs/ARCHITECTURE.md).
// `participants` is NOT required — attendees come from status.review (user input),
// and the summarizer emits []. Every other field is always present (fallback path
// fills purpose:"" and highlights from discussion), so they are required here.

export const actionItemSchema = z.object({
  owner: z.string(),
  task: z.string(),
  due: z.string(),
});

export const summarySchema = z.object({
  title: z.string(),
  topicSlug: z.string(),
  oneLine: z.string(),
  purpose: z.string(),
  participants: z.array(z.string()).default([]),
  highlights: z.array(z.string()),
  discussion: z.array(z.string()),
  decisions: z.array(z.string()),
  actionItems: z.array(actionItemSchema),
  risks: z.array(z.string()),
  followups: z.array(z.string()),
});
