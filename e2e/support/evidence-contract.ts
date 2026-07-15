export const REQUIRED_SYNTHETIC_VIEWPORTS = [
  "desktop-1440",
  "mobile-390",
  "mobile-320",
] as const;

export const SYNTHETIC_BROWSER_SMOKE_REQUIREMENT = "SYNTHETIC-BROWSER-SMOKE";

interface AnnotationLike {
  type: string;
  description?: string;
}

interface AnnotationCarrier {
  annotations?: readonly AnnotationLike[];
}

export interface RequirementCoverage {
  coveredRequirements: string[];
  invalidAnnotations: string[];
}

function normalizeRequirement(value: string): string | null {
  const match = /^R(\d+)$/iu.exec(value.trim());
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return `R${number}`;
}

export function collectRequirementCoverage(
  tests: readonly AnnotationCarrier[],
): RequirementCoverage {
  const covered = new Set<string>();
  const invalid = new Set<string>();
  for (const test of tests) {
    for (const annotation of test.annotations ?? []) {
      if (annotation.type !== "requirement") continue;
      const raw = typeof annotation.description === "string" ? annotation.description : "";
      const normalized = normalizeRequirement(raw);
      if (normalized) covered.add(normalized);
      else invalid.add(raw || "<missing>");
    }
  }
  const coveredRequirements = [...covered].sort((left, right) => (
    Number(left.slice(1)) - Number(right.slice(1))
  ));
  return {
    coveredRequirements: coveredRequirements.length > 0
      ? coveredRequirements
      : invalid.size === 0
        ? [SYNTHETIC_BROWSER_SMOKE_REQUIREMENT]
        : [],
    invalidAnnotations: [...invalid].sort(),
  };
}

export interface TestAttachmentCoverage {
  id: string;
  viewport: string;
  screenshotCount: number;
  consoleCount: number;
  networkCount: number;
}

export function validateEvidenceAttachments(input: {
  requiredViewports: readonly string[];
  tests: readonly TestAttachmentCoverage[];
}): {
  complete: boolean;
  missingViewports: string[];
  unexpectedViewports: string[];
  incompleteTests: string[];
} {
  const observed = new Set(input.tests.map((test) => test.viewport));
  const required = new Set(input.requiredViewports);
  const missingViewports = input.requiredViewports.filter((viewport) => !observed.has(viewport));
  const unexpectedViewports = [...observed].filter((viewport) => !required.has(viewport)).sort();
  const incompleteTests = input.tests
    .filter((test) => (
      test.screenshotCount < 1
      || test.consoleCount !== 1
      || test.networkCount !== 1
    ))
    .map((test) => test.id)
    .sort();
  return {
    complete:
      input.tests.length > 0
      && missingViewports.length === 0
      && unexpectedViewports.length === 0
      && incompleteTests.length === 0,
    missingViewports,
    unexpectedViewports,
    incompleteTests,
  };
}
