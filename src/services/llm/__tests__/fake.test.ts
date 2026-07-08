// @vitest-environment node
import { describe, expect, it } from "vitest";

import { getAdapter } from "@/services/llm";
import { FakeAdapter } from "@/services/llm/fake";

const SUMMARY_KEYS = ["title", "oneLine", "purpose", "participants", "highlights", "actionItems"];

describe("FakeAdapter", () => {
  it("returns schema-shaped summary JSON for a summary-style prompt", async () => {
    const fake = new FakeAdapter();

    // opts.json triggers the canned summary...
    const viaJsonOpt = JSON.parse(await fake.run("아무 프롬프트", { json: true }));
    expect(typeof viaJsonOpt).toBe("object");
    for (const key of SUMMARY_KEYS) expect(viaJsonOpt).toHaveProperty(key);
    expect(viaJsonOpt.participants).toEqual([]);

    // ...as does the "JSON 스키마" marker present in the real summary prompt.
    const viaMarker = await fake.run("규칙 ...\nJSON 스키마: {...}");
    expect(() => JSON.parse(viaMarker)).not.toThrow();
  });

  it("passes the raw transcript through for a correction prompt", async () => {
    const text = "안녕하세요 회의를 시작합니다 오늘 안건은 세 가지입니다";
    const out = await new FakeAdapter().run(`교정 규칙 ...\n\n[원문]\n${text}`);
    expect(out).toBe(text);
    // similar length to <text> (passthrough, not a summary)
    expect(Math.abs(out.length - text.length)).toBeLessThanOrEqual(1);
  });

  it("reports healthy", async () => {
    const health = await new FakeAdapter().health();
    expect(health.ok).toBe(true);
  });

  it("getAdapter returns a FakeAdapter when FAKE_LLM=1", () => {
    const saved = process.env.FAKE_LLM;
    process.env.FAKE_LLM = "1";
    try {
      expect(getAdapter({ provider: "claude-cli" })).toBeInstanceOf(FakeAdapter);
    } finally {
      if (saved === undefined) delete process.env.FAKE_LLM;
      else process.env.FAKE_LLM = saved;
    }
  });
});
