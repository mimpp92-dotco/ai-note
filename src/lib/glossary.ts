import { readFile } from "node:fs/promises";

import { type Glossary, glossarySchema } from "@/domain/glossary";
import { atomicWriteFile } from "@/lib/atomicWrite";
import { localSttGlossaryPath } from "@/lib/config";

// Read/write the glossary file (path from config, repo-root glossary.json, env
// override). app-api is the single writer. Reads are best-effort: any missing
// file / bad JSON / schema failure degrades to an empty glossary so the correction
// step never aborts. A legacy string[] file is coerced to the {terms,corrections}
// shape (backward compatible).

const EMPTY: Glossary = { terms: [], corrections: [] };

export async function readGlossary(): Promise<Glossary> {
  try {
    const parsed: unknown = JSON.parse(await readFile(localSttGlossaryPath(), "utf-8"));
    // Backward compat: a bare JSON array is the old flat term list.
    const candidate = Array.isArray(parsed) ? { terms: parsed, corrections: [] } : parsed;
    const result = glossarySchema.safeParse(candidate);
    return result.success ? result.data : EMPTY;
  } catch {
    return EMPTY;
  }
}

export async function writeGlossary(glossary: Glossary): Promise<void> {
  await atomicWriteFile(localSttGlossaryPath(), JSON.stringify(glossary, null, 2) + "\n");
}
