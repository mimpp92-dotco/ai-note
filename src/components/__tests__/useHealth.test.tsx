// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// useHealth keeps module-level state (timers + in-flight flags), so reset the
// module between tests to get a fresh, isolated poller each time.
describe("useHealth — in-flight dedup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not overlap LLM health fetches while one is still in flight", async () => {
    let llmCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/settings/llm/health") {
          llmCalls += 1;
          return new Promise<never>(() => {}); // never settles — stays in flight
        }
        return new Promise<never>(() => {});
      }),
    );

    const { useHealth } = await import("@/components/useHealth");
    renderHook(() => useHealth());

    // Mount → startPolling issues the first llm fetch.
    expect(llmCalls).toBe(1);

    // Several poll intervals elapse while the first fetch is still pending; the
    // dedup guard must suppress the overlapping calls (no stacking heavy calls).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });
    expect(llmCalls).toBe(1);
  });

  it("a rejected fetch does not wedge the poller (finally resets the flag)", async () => {
    let llmCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/settings/llm/health") {
          llmCalls += 1;
          return Promise.reject(new Error("network"));
        }
        return new Promise<never>(() => {});
      }),
    );

    const { useHealth } = await import("@/components/useHealth");
    renderHook(() => useHealth());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0); // flush the rejection + finally
    });
    expect(llmCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000); // the next poll must fire again
    });
    expect(llmCalls).toBe(2);
  });
});
