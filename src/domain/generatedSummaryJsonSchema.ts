// Static provider-facing schema for generated summaries only. Manual `body`,
// titleOverride, and review metadata belong to separate app writers and are not
// valid model output. Model-derived attendees are deliberately disabled:
// status.review remains the only authoritative participant source.
export const GENERATED_SUMMARY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "topicSlug",
    "oneLine",
    "purpose",
    "participants",
    "highlights",
    "discussion",
    "decisions",
    "actionItems",
    "risks",
    "followups",
  ],
  properties: {
    title: { type: "string" },
    topicSlug: { type: "string" },
    oneLine: { type: "string" },
    purpose: { type: "string" },
    participants: {
      type: "array",
      maxItems: 0,
      items: { type: "string" },
    },
    highlights: {
      type: "array",
      items: { type: "string" },
    },
    discussion: {
      type: "array",
      items: { type: "string" },
    },
    decisions: {
      type: "array",
      items: { type: "string" },
    },
    actionItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["owner", "task", "due"],
        properties: {
          owner: { type: "string" },
          task: { type: "string" },
          due: { type: "string" },
        },
      },
    },
    risks: {
      type: "array",
      items: { type: "string" },
    },
    followups: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

export type GeneratedSummaryJsonSchema = typeof GENERATED_SUMMARY_JSON_SCHEMA;
