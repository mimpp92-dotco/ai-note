import { z } from "zod";

// Glossary contract (dependency-free zod). Two lists:
//   terms       — domain vocabulary to prefer when correcting STT output
//   corrections — "misheard → correct" pairs applied in the correction step
// The schema NORMALIZES on parse (single source of truth for cleaning): trims all
// strings, drops empty/whitespace-only entries, drops no-op (from===to) pairs,
// dedupes (terms by value, corrections by `from`), and caps sizes so the prompt
// stays bounded. Legacy string[] files are coerced to this shape in lib/glossary.ts.

const MAX_STRING_LEN = 200;
const MAX_ITEMS = 500;

export const correctionSchema = z.object({
  from: z.string(),
  to: z.string(),
});

export const glossarySchema = z
  .object({
    terms: z.array(z.string()).default([]),
    corrections: z.array(correctionSchema).default([]),
  })
  .transform(({ terms, corrections }) => {
    const cleanTerms = Array.from(
      new Set(terms.map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= MAX_STRING_LEN)),
    ).slice(0, MAX_ITEMS);

    const seenFrom = new Set<string>();
    const cleanCorrections: { from: string; to: string }[] = [];
    for (const c of corrections) {
      const from = c.from.trim();
      const to = c.to.trim();
      if (from.length === 0 || to.length === 0) continue; // both required
      if (from === to) continue; // no-op
      if (from.length > MAX_STRING_LEN || to.length > MAX_STRING_LEN) continue;
      if (seenFrom.has(from)) continue; // dedupe by source term (first wins)
      seenFrom.add(from);
      cleanCorrections.push({ from, to });
    }

    return { terms: cleanTerms, corrections: cleanCorrections.slice(0, MAX_ITEMS) };
  });

export type Glossary = z.infer<typeof glossarySchema>;
export type Correction = z.infer<typeof correctionSchema>;
