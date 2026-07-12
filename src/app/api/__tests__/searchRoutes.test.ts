// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const searchState = vi.hoisted(() => ({
  search: vi.fn(),
}));

vi.mock("@/lib/meetingSearch", () => {
  class MeetingSearchInputError extends Error {
    readonly code = "invalid_query";
  }
  class MeetingSearchRetryError extends Error {
    readonly code = "library_generation_changed";
  }
  return {
    MeetingSearchInputError,
    MeetingSearchRetryError,
    searchStoredMeetings: searchState.search,
  };
});

import {
  dynamic,
  GET as searchRoute,
  runtime,
} from "@/app/api/search/route";

const ORIGIN = "http://127.0.0.1:3000";
const WORKSPACE = "10000000-0000-4000-8000-000000000001";
const FOLDER = "30000000-0000-4000-8000-000000000003";

function request(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/search${query}`, {
    headers: { host: "127.0.0.1:3000", ...headers },
  });
}

const safePayload = {
  query: "로드맵",
  results: [{
    meetingId: "meeting-1",
    title: "제품 로드맵",
    status: "summarized",
    startedAt: "2026-07-12T00:00:00.000Z",
    location: {
      workspaceId: WORKSPACE,
      folderId: FOLDER,
      breadcrumb: ["기본", "제품"],
    },
    matches: [{ field: "title", label: "제목", excerpt: "제품 로드맵" }],
    href: "/meetings/meeting-1",
  }],
  hasMore: false,
  summaryPendingCount: 0,
  index: { status: "ready", reasons: [], reindexable: false },
};

beforeEach(() => {
  searchState.search.mockReset();
  searchState.search.mockResolvedValue(safePayload);
});

describe("GET /api/search", () => {
  it("uses the Node dynamic contract and applies the local guard before parsing/query work", async () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");

    const response = await searchRoute(new Request("http://evil.test/api/search?%", {
      headers: { host: "evil.test" },
    }));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(searchState.search).not.toHaveBeenCalled();
  });

  it("validates bounded query/filter input and passes a normalized typed request to the service", async () => {
    const response = await searchRoute(request(
      `?q=${encodeURIComponent("  로드맵  ")}`
      + `&dateFrom=2026-07-01&dateTo=2026-07-31&workspaceId=${WORKSPACE}`
      + `&folderId=${FOLDER}&status=summarized&hasActionItem=true&limit=12`,
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(searchState.search).toHaveBeenCalledWith({
      query: "  로드맵  ",
      filters: {
        dateFrom: "2026-07-01",
        dateTo: "2026-07-31",
        workspaceId: WORKSPACE,
        folderId: FOLDER,
        status: "summarized",
        hasActionItem: true,
      },
      limit: 12,
    });
  });

  it.each([
    "",
    "?q=",
    "?q=%20%20%20",
    `?q=${"a".repeat(501)}`,
    "?q=ok&limit=0",
    "?q=ok&limit=51",
    "?q=ok&limit=1.5",
    "?q=ok&limit=abc",
    "?q=ok&status=done",
    "?q=ok&q=again",
    "?q=ok&unknown=true",
    "?q=ok&dateFrom=2026-02-30",
    "?q=ok&dateFrom=2026-07-31&dateTo=2026-07-01",
    "?q=ok&workspaceId=not-a-uuid",
    "?q=ok&folderId=not-a-folder",
    "?q=ok&hasActionItem=yes",
  ])("rejects invalid or ambiguous input %s", async (query) => {
    const response = await searchRoute(request(query));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(searchState.search).not.toHaveBeenCalled();
  });

  it("accepts the explicit unfiled filter and applies the default limit", async () => {
    await searchRoute(request(`?q=회의&workspaceId=${WORKSPACE}&folderId=unfiled`));
    expect(searchState.search).toHaveBeenCalledWith({
      query: "회의",
      filters: { workspaceId: WORKSPACE, folderId: null },
      limit: 20,
    });
  });

  it("returns only the safe no-store public DTO without score, paths, or raw errors", async () => {
    const response = await searchRoute(request("?q=로드맵"));
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(body).toEqual(safePayload);
    expect(Object.keys(body).sort()).toEqual([
      "hasMore",
      "index",
      "query",
      "results",
      "summaryPendingCount",
    ]);
    expect(Object.keys(body.results[0]).sort()).toEqual([
      "href",
      "location",
      "matches",
      "meetingId",
      "startedAt",
      "status",
      "title",
    ]);
    expect(serialized).not.toContain("score");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("status.json");
    expect(serialized).not.toContain("provider");
  });

  it("lowers a generation race to a typed retry response", async () => {
    const { MeetingSearchRetryError } = await import("@/lib/meetingSearch");
    searchState.search.mockRejectedValueOnce(new MeetingSearchRetryError());
    const response = await searchRoute(request("?q=로드맵"));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "search_retry",
        message: "회의 구성이 변경되었습니다. 다시 검색해 주세요",
      },
    });
  });
});
