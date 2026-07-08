// @vitest-environment node
import { describe, expect, it } from "vitest";

import { runProcess } from "@/services/llm/exec";

// Uses `node` as the child so the assertions are deterministic and dependency-free.

describe("runProcess", () => {
  it("captures stdout", async () => {
    const { stdout } = await runProcess("node", ["-e", "process.stdout.write('hi')"]);
    expect(stdout).toBe("hi");
  });

  it("pipes stdin to the child (never argv)", async () => {
    const { stdout } = await runProcess(
      "node",
      ["-e", "process.stdin.on('data',d=>process.stdout.write(d))"],
      { stdin: "echo-me" },
    );
    expect(stdout).toBe("echo-me");
  });

  it("rejects on a nonzero exit code", async () => {
    await expect(runProcess("node", ["-e", "process.exit(3)"])).rejects.toThrow();
  });

  it("rejects when the process exceeds the timeout", async () => {
    await expect(
      runProcess("node", ["-e", "setTimeout(()=>{},5000)"], { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out/);
  });

  it("rejects when the binary does not exist (ENOENT)", async () => {
    await expect(runProcess("definitely-not-a-real-binary-xyz", [])).rejects.toThrow();
  });
});
