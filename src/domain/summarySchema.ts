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

const editableText = z.string().trim();
const editableListItem = z.string().trim().min(1);

// Exact public/manual-edit projection. Internal canonical fields
// (title/topicSlug/participants) are deliberately absent and unknown fields
// fail instead of being silently stripped.
export const editableSummarySchema = z.object({
  oneLine: editableText,
  purpose: editableText,
  highlights: z.array(editableListItem),
  discussion: z.array(editableListItem),
  decisions: z.array(editableListItem),
  actionItems: z.array(actionItemSchema.strict()),
  risks: z.array(editableListItem),
  followups: z.array(editableListItem),
}).strict();

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
