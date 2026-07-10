// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the subprocess helper so run() never shells out; we only assert the args it
// hands to runProcess. The real LLM_GENERATION_TIMEOUT_MS constant is kept.
vi.mock("@/services/llm/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/llm/exec")>();
  return { ...actual, runProcess: vi.fn(async () => ({ stdout: "요약 결과", stderr: "" })) };
});

import { ClaudeCliAdapter } from "@/services/llm/claudeCli";
import { LLM_GENERATION_TIMEOUT_MS, runProcess } from "@/services/llm/exec";

const runProcessMock = vi.mocked(runProcess);

describe("ClaudeCliAdapter.run — generation timeout", () => {
  beforeEach(() => runProcessMock.mockClear());

  it("passes the 10-minute LLM generation timeout (not the 120s default)", async () => {
    expect(LLM_GENERATION_TIMEOUT_MS).toBe(600_000);

    await new ClaudeCliAdapter({ provider: "claude-cli" }).run("프롬프트");

    expect(runProcessMock).toHaveBeenCalledWith(
      "claude",
      ["-p"],
      expect.objectContaining({ stdin: "프롬프트", timeoutMs: LLM_GENERATION_TIMEOUT_MS }),
    );
  });
});
