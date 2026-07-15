import { z } from "zod";

import {
  actionItemSchema,
  editableSummarySchema,
  summarySchema,
} from "@/domain/summarySchema";

export type ActionItem = z.infer<typeof actionItemSchema>;
export type Summary = z.infer<typeof summarySchema>;
export type EditableSummary = z.infer<typeof editableSummarySchema>;
