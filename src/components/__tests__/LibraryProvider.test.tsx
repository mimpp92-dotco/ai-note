// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LibraryProvider,
  useLibrary,
  type LibraryProviderValue,
} from "@/components/LibraryProvider";

const VERSION = {
  libraryId: "10000000-0000-4000-8000-000000000010",
  revision: 0,
};

const NEW_VERSION = {
  libraryId: "20000000-0000-4000-8000-000000000020",
  revision: 0,
};

const LIBRARY_RESPONSE = {
  mode: "ready",
  version: VERSION,
  library: {
    defaultWorkspaceId: "10000000-0000-4000-8000-000000000001",
    workspaces: [{
      id: "10000000-0000-4000-8000-000000000001",
      name: "기본",
      order: 0,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    }],
    folders: [],
    counts: {
      visibleMeetingCount: 0,
      hiddenInvalidStatusCount: 0,
      organizationPendingCount: 0,
      workspaces: [{
        workspaceId: "10000000-0000-4000-8000-000000000001",
        total: 0,
        unfiled: 0,
      }],
      folders: [],
    },
  },
};

const SUMMARY_RESPONSE = {
  summaryWork: { processing: 2, needsAttention: 1, attention: null },
  observedAt: "2026-07-10T00:00:00.000Z",
};

function pendingResponse(count: number, version = VERSION) {
  return {
    count,
    rows: [],
    nextCursor: null,
    observedAt: "2026-07-10T00:00:00.000Z",
    sequence: String(count).padStart(64, "0"),
    version,
  };
}

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let latest: LibraryProviderValue | null = null;

function Probe({ label }: { label: string }) {
  latest = useLibrary();
  return (
    <output data-testid={label}>
      {latest.mode}:{latest.summaryWork?.summaryWork.processing ?? "-"}:{latest.organizationPending?.count ?? "-"}
    </output>
  );
}

describe("LibraryProvider polling ownership", () => {
  afterEach(() => {
    latest = null;
    vi.unstubAllGlobals();
  });

  it("owns one library/summary/pending poller even with multiple consumers", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/library") return response(LIBRARY_RESPONSE);
      if (url === "/api/summary-work") return response(SUMMARY_RESPONSE);
      if (url.startsWith("/api/organization-pending")) return response(pendingResponse(0));
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <LibraryProvider>
        <Probe label="first" />
        <Probe label="second" />
      </LibraryProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("first")).toHaveTextContent("ready:2:0"));
    expect(screen.getByTestId("second")).toHaveTextContent("ready:2:0");
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/library")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/summary-work")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/organization-pending")))
      .toHaveLength(1);
  });

  it("does not revive pending rows from a response started before invalidation", async () => {
    let resolveOld: ((value: Response) => void) | null = null;
    let pendingCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/library") return response(LIBRARY_RESPONSE);
      if (url === "/api/summary-work") return response(SUMMARY_RESPONSE);
      if (url.startsWith("/api/organization-pending")) {
        pendingCalls += 1;
        if (pendingCalls === 1) return new Promise<Response>((resolve) => { resolveOld = resolve; });
        return response(pendingResponse(0));
      }
      throw new Error(`unexpected ${url}`);
    }));
    render(<LibraryProvider><Probe label="state" /></LibraryProvider>);
    await waitFor(() => expect(latest?.mode).toBe("ready"));
    act(() => latest!.invalidateOrganizationPending());
    await act(async () => {
      resolveOld!(response(pendingResponse(1)));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("ready:2:0"));
    expect(pendingCalls).toBe(2);
  });

  it("atomically resets every library-owned resource before accepting revision zero from a new generation", async () => {
    let libraryCalls = 0;
    let summaryCalls = 0;
    let pendingCalls = 0;
    let resolveNewLibrary: ((value: Response) => void) | null = null;
    let resolveLateSummary: ((value: Response) => void) | null = null;
    let resolveLatePending: ((value: Response) => void) | null = null;
    const newLibrary = {
      ...LIBRARY_RESPONSE,
      version: NEW_VERSION,
      library: {
        ...LIBRARY_RESPONSE.library,
        defaultWorkspaceId: "20000000-0000-4000-8000-000000000002",
        workspaces: [{
          ...LIBRARY_RESPONSE.library.workspaces[0],
          id: "20000000-0000-4000-8000-000000000002",
          name: "재구축됨",
        }],
        counts: {
          ...LIBRARY_RESPONSE.library.counts,
          workspaces: [{
            workspaceId: "20000000-0000-4000-8000-000000000002",
            total: 0,
            unfiled: 0,
          }],
        },
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/library") {
        libraryCalls += 1;
        if (libraryCalls === 1) return response(LIBRARY_RESPONSE);
        return new Promise<Response>((resolve) => { resolveNewLibrary = resolve; });
      }
      if (url.startsWith("/api/summary-work?")) {
        return new Promise<Response>((resolve) => { resolveLateSummary = resolve; });
      }
      if (url === "/api/summary-work") {
        summaryCalls += 1;
        return response(summaryCalls === 1
          ? SUMMARY_RESPONSE
          : { ...SUMMARY_RESPONSE, summaryWork: { processing: 0, needsAttention: 0, attention: null } });
      }
      if (url.startsWith("/api/organization-pending")) {
        if (url.includes("cursor=late")) {
          return new Promise<Response>((resolve) => { resolveLatePending = resolve; });
        }
        pendingCalls += 1;
        return response(pendingCalls === 1
          ? pendingResponse(1)
          : pendingResponse(0, NEW_VERSION));
      }
      throw new Error(`unexpected ${url}`);
    }));

    render(<LibraryProvider><Probe label="generation" /></LibraryProvider>);
    await waitFor(() => expect(screen.getByTestId("generation")).toHaveTextContent("ready:2:1"));
    act(() => {
      latest!.refreshSummaryWork("late");
      latest!.refreshOrganizationPending("late");
    });
    await waitFor(() => {
      expect(resolveLateSummary).not.toBeNull();
      expect(resolveLatePending).not.toBeNull();
    });
    act(() => {
      latest!.toggleFolder("30000000-0000-4000-8000-000000000003");
      latest!.resetForGeneration();
    });
    await waitFor(() => {
      expect(latest?.mode).toBe("loading");
      expect(latest?.version).toBeNull();
      expect(latest?.summaryWork).toBeNull();
      expect(latest?.organizationPending).toBeNull();
      expect(latest?.generationEpoch).toBe(1);
      expect(latest?.expandedFolderIds.size).toBe(0);
      expect(latest?.pages.entities.size).toBe(0);
    });

    await act(async () => {
      resolveNewLibrary!(response(newLibrary));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(latest?.version).toEqual(NEW_VERSION);
      expect(screen.getByTestId("generation")).toHaveTextContent("ready:0:0");
    });
    await act(async () => {
      resolveLateSummary!(response({
        ...SUMMARY_RESPONSE,
        summaryWork: { processing: 99, needsAttention: 99, attention: null },
      }));
      resolveLatePending!(response(pendingResponse(99)));
      await Promise.resolve();
    });
    expect(screen.getByTestId("generation")).toHaveTextContent("ready:0:0");
    expect(libraryCalls).toBe(2);
    expect(summaryCalls).toBe(2);
    expect(pendingCalls).toBe(2);
  });

  it("aborts and permanently discards a mutation response from the previous generation", async () => {
    let libraryCalls = 0;
    let resolveMutation: ((value: Response) => void) | null = null;
    const mutationRequest: { signal?: AbortSignal } = {};
    const newLibrary = {
      ...LIBRARY_RESPONSE,
      version: NEW_VERSION,
      library: {
        ...LIBRARY_RESPONSE.library,
        defaultWorkspaceId: "20000000-0000-4000-8000-000000000002",
        workspaces: [{
          ...LIBRARY_RESPONSE.library.workspaces[0],
          id: "20000000-0000-4000-8000-000000000002",
        }],
        counts: {
          ...LIBRARY_RESPONSE.library.counts,
          workspaces: [{
            workspaceId: "20000000-0000-4000-8000-000000000002",
            total: 0,
            unfiled: 0,
          }],
        },
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === "/api/library") {
        libraryCalls += 1;
        return response(libraryCalls === 1 ? LIBRARY_RESPONSE : newLibrary);
      }
      if (url === "/api/summary-work") return response(SUMMARY_RESPONSE);
      if (url.startsWith("/api/organization-pending")) {
        return response(pendingResponse(0, libraryCalls > 1 ? NEW_VERSION : VERSION));
      }
      if (url === "/api/library-mutation") {
        mutationRequest.signal = init?.signal as AbortSignal;
        return new Promise<Response>((resolve) => { resolveMutation = resolve; });
      }
      throw new Error(`unexpected ${url}`);
    }));
    render(<LibraryProvider><Probe label="stale-mutation" /></LibraryProvider>);
    await waitFor(() => expect(latest?.version).toEqual(VERSION));

    let mutationPromise: ReturnType<LibraryProviderValue["runLibraryMutation"]>;
    act(() => {
      mutationPromise = latest!.runLibraryMutation("/api/library-mutation", { method: "PATCH" });
    });
    await waitFor(() => expect(resolveMutation).not.toBeNull());
    act(() => latest!.resetForGeneration());
    expect(mutationRequest.signal?.aborted).toBe(true);
    await act(async () => {
      resolveMutation!(response({ ...LIBRARY_RESPONSE, version: { ...VERSION, revision: 99 } }));
      await Promise.resolve();
    });
    const result = await mutationPromise!;
    expect(result.accepted).toBe(false);
    expect(result.payload).toBeNull();
    await waitFor(() => expect(latest?.version).toEqual(NEW_VERSION));
    expect(latest?.applyMeetingMove?.("meeting-1", {
      workspaceId: "20000000-0000-4000-8000-000000000002",
      folderId: null,
    })).toBe(false);
  });
});
