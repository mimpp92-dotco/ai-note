// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localSttGlossaryPath } from "@/lib/config";
import { readGlossary, writeGlossary } from "@/lib/glossary";

// localSttGlossaryPath() = cwd/glossary.json (unless LOCAL_STT_GLOSSARY is set), so
// isolate via chdir into a temp dir and clear the env override.

let workDir: string;
let originalCwd: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.LOCAL_STT_GLOSSARY;
  delete process.env.LOCAL_STT_GLOSSARY;
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "glossary-"));
  process.chdir(workDir);
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.LOCAL_STT_GLOSSARY;
  else process.env.LOCAL_STT_GLOSSARY = savedEnv;
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

describe("glossary", () => {
  it("returns an empty glossary when the file is absent", async () => {
    expect(await readGlossary()).toEqual({ terms: [], corrections: [] });
  });

  it("round-trips terms and corrections", async () => {
    await writeGlossary({ terms: ["프로덕트 로드맵"], corrections: [{ from: "김민중", to: "김민준" }] });
    expect(await readGlossary()).toEqual({
      terms: ["프로덕트 로드맵"],
      corrections: [{ from: "김민중", to: "김민준" }],
    });
  });

  it("coerces a legacy string[] file to the new object shape", async () => {
    await writeFile(localSttGlossaryPath(), JSON.stringify(["Kubernetes", "OKR", "roadmap"]));
    expect(await readGlossary()).toEqual({
      terms: ["Kubernetes", "OKR", "roadmap"],
      corrections: [],
    });
  });

  it("falls back to empty on a corrupt object / bad JSON", async () => {
    await writeFile(localSttGlossaryPath(), '{"terms": "not-an-array"}');
    expect(await readGlossary()).toEqual({ terms: [], corrections: [] });

    await writeFile(localSttGlossaryPath(), "{ this is not json");
    expect(await readGlossary()).toEqual({ terms: [], corrections: [] });
  });

  it("normalizes on write→read: trim, drop empties, dedupe, drop from===to", async () => {
    await writeGlossary({
      // parsed by the route/schema before write; here we exercise read normalization
      terms: ["  OKR  ", "OKR", "", "   ", "roadmap"],
      corrections: [
        { from: " 김민중 ", to: " 김민준 " },
        { from: "김민중", to: "김민준" }, // dup `from`
        { from: "동일", to: "동일" }, // no-op
        { from: "   ", to: "채움" }, // empty from
      ],
    } as unknown as Parameters<typeof writeGlossary>[0]);
    // writeGlossary serializes verbatim, so normalization is verified via read (schema).
    const got = await readGlossary();
    expect(got.terms).toEqual(["OKR", "roadmap"]);
    expect(got.corrections).toEqual([{ from: "김민중", to: "김민준" }]);
  });
});
