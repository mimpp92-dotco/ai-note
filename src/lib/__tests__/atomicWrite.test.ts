import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { atomicWriteFile } from "@/lib/atomicWrite";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atomic-write-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("atomicWriteFile", () => {
  it("round-trips a string payload", async () => {
    const target = join(dir, "status.json");
    const payload = JSON.stringify({ hello: "월드" });
    await atomicWriteFile(target, payload);
    expect(await readFile(target, "utf-8")).toBe(payload);
  });

  it("round-trips binary data", async () => {
    const target = join(dir, "audio.bin");
    const bytes = new Uint8Array([0, 255, 42, 7]);
    await atomicWriteFile(target, bytes);
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
  });

  it("creates missing parent directories", async () => {
    const target = join(dir, "meetings", "abc", "raw.md");
    await atomicWriteFile(target, "본문");
    expect(await readFile(target, "utf-8")).toBe("본문");
  });

  it("leaves no stray temp file behind", async () => {
    const target = join(dir, "summary.json");
    await atomicWriteFile(target, "{}");
    const entries = await readdir(dir);
    expect(entries).toEqual(["summary.json"]);
  });
});
