import { z } from "zod";

import { MEETING_STATUSES } from "@/domain/meeting";
import {
  MeetingSearchInputError,
  MeetingSearchRetryError,
  searchStoredMeetings,
  type MeetingSearchFilters,
  type MeetingSearchResponse,
} from "@/lib/meetingSearch";
import { guardLocalApiRequest } from "@/lib/localRequestGuard";
import { jsonNoStore, publicErrorResponse, safeLog } from "@/lib/publicApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_QUERY_KEYS = new Set([
  "q",
  "dateFrom",
  "dateTo",
  "workspaceId",
  "folderId",
  "status",
  "hasActionItem",
  "limit",
]);

function validCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && !Number.isNaN(date.valueOf())
    && date.toISOString().slice(0, 10) === value;
}

const searchQuerySchema = z.object({
  q: z.string().max(500).refine((value) => value.trim().length > 0),
  dateFrom: z.string().refine(validCalendarDate).optional(),
  dateTo: z.string().refine(validCalendarDate).optional(),
  workspaceId: z.string().uuid().optional(),
  folderId: z.union([z.string().uuid(), z.literal("unfiled")]).optional(),
  status: z.enum(MEETING_STATUSES).optional(),
  hasActionItem: z.enum(["true", "false"]).optional(),
  limit: z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/u).optional(),
}).strict().superRefine((value, context) => {
  if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) {
    context.addIssue({ code: "custom", path: ["dateTo"], message: "invalid_date_range" });
  }
});

function parseQuery(search: URLSearchParams): z.infer<typeof searchQuerySchema> | null {
  for (const key of search.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key) || search.getAll(key).length !== 1) return null;
  }
  const raw = Object.fromEntries(search.entries());
  const parsed = searchQuerySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function unavailable(query: string): MeetingSearchResponse {
  return {
    query: query.trim(),
    results: [],
    hasMore: false,
    summaryPendingCount: 0,
    index: { status: "unavailable", reasons: ["io_error"], reindexable: true },
  };
}

export async function GET(request: Request): Promise<Response> {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;

  const parsed = parseQuery(new URL(request.url).searchParams);
  if (!parsed) return publicErrorResponse("invalid_request", 400);
  const filters: MeetingSearchFilters = {
    ...(parsed.dateFrom ? { dateFrom: parsed.dateFrom } : {}),
    ...(parsed.dateTo ? { dateTo: parsed.dateTo } : {}),
    ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
    ...(parsed.folderId !== undefined
      ? { folderId: parsed.folderId === "unfiled" ? null : parsed.folderId }
      : {}),
    ...(parsed.status ? { status: parsed.status } : {}),
    ...(parsed.hasActionItem !== undefined
      ? { hasActionItem: parsed.hasActionItem === "true" }
      : {}),
  };

  try {
    return jsonNoStore(await searchStoredMeetings({
      query: parsed.q,
      filters,
      limit: parsed.limit ? Number(parsed.limit) : 20,
    }));
  } catch (error) {
    if (error instanceof MeetingSearchInputError) {
      return publicErrorResponse("invalid_request", 400);
    }
    if (error instanceof MeetingSearchRetryError) {
      return jsonNoStore({
        error: {
          code: "search_retry",
          message: "회의 구성이 변경되었습니다. 다시 검색해 주세요",
        },
      }, 409);
    }
    safeLog("warn", { code: "meeting_search_failed", operation: "meeting_search" });
    return jsonNoStore(unavailable(parsed.q));
  }
}
