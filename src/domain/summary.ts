import { z } from "zod";

import { actionItemSchema, summarySchema } from "@/domain/summarySchema";

export type ActionItem = z.infer<typeof actionItemSchema>;
export type Summary = z.infer<typeof summarySchema>;
