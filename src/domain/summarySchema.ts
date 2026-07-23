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
const manualBody = z.string().refine((value) => value.trim().length > 0, {
  message: "summary body must contain non-whitespace text",
});

// Legacy structured editor projection retained while the client migrates to a
// freeform body. Internal canonical fields are deliberately absent.
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
  body: manualBody.optional(),
  oneLine: z.string(),
  purpose: z.string(),
  participants: z.array(z.string()).default([]),
  highlights: z.array(z.string()),
  discussion: z.array(z.string()),
  decisions: z.array(z.string()),
  actionItems: z.array(actionItemSchema),
  risks: z.array(z.string()),
  followups: z.array(z.string()),
}).superRefine((summary, context) => {
  if (summary.body === undefined) return;

  const populatedFields = [
    ...(summary.oneLine.length === 0 ? [] : ["oneLine"]),
    ...(summary.purpose.length === 0 ? [] : ["purpose"]),
    ...(summary.highlights.length === 0 ? [] : ["highlights"]),
    ...(summary.discussion.length === 0 ? [] : ["discussion"]),
    ...(summary.decisions.length === 0 ? [] : ["decisions"]),
    ...(summary.actionItems.length === 0 ? [] : ["actionItems"]),
    ...(summary.risks.length === 0 ? [] : ["risks"]),
    ...(summary.followups.length === 0 ? [] : ["followups"]),
  ];
  for (const field of populatedFields) {
    context.addIssue({
      code: "custom",
      path: [field],
      message: "manual body cannot coexist with structured summary content",
    });
  }
});
