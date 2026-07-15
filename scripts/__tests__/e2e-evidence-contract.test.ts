// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import EvidenceReporter from "../../e2e/support/evidence-reporter";
import {
  REQUIRED_SYNTHETIC_VIEWPORTS,
  collectRequirementCoverage,
  validateEvidenceAttachments,
} from "../../e2e/support/evidence-contract";

const roots: string[] = [];
const originalEvidenceRoot = process.env.AI_EXECUTE_BROWSER_EVIDENCE_DIR;

afterEach(async () => {
  if (originalEvidenceRoot === undefined) delete process.env.AI_EXECUTE_BROWSER_EVIDENCE_DIR;
  else process.env.AI_EXECUTE_BROWSER_EVIDENCE_DIR = originalEvidenceRoot;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeTest(project: string, title: string, requirements: string[] = []) {
  return {
    annotations: requirements.map((description) => ({ type: "requirement", description })),
    titlePath: () => [project, title],
    parent: { project: () => ({ name: project }) },
  };
}

function attachment(name: string, value: unknown) {
  return {
    name,
    body: Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)),
    contentType: name.startsWith("browser-screenshot") ? "image/png" : "application/json",
  };
}

function fakeResult(screenshotName = "browser-screenshot") {
  return {
    status: "passed",
    errors: [],
    attachments: [
      attachment(screenshotName, Buffer.from("synthetic-png")),
      attachment("browser-console", { errors: [] }),
      attachment("browser-network", { externalRequests: [] }),
    ],
  };
}

async function evidenceRoot() {
  const root = await mkdtemp(join(tmpdir(), "e2e-evidence-contract-"));
  roots.push(root);
  const evidence = join(root, "playwright-evidence");
  process.env.AI_EXECUTE_BROWSER_EVIDENCE_DIR = evidence;
  return evidence;
}

describe("Playwright evidence requirement contract", () => {
  it("normalizes requirement annotations and keeps smoke-only compatibility", () => {
    expect(collectRequirementCoverage([
      { annotations: [{ type: "requirement", description: " r9 " }] },
      { annotations: [{ type: "requirement", description: "R7" }] },
      { annotations: [{ type: "requirement", description: "R8" }] },
      { annotations: [{ type: "other", description: "ignored" }] },
    ])).toEqual({
      coveredRequirements: ["R7", "R8", "R9"],
      invalidAnnotations: [],
    });
    expect(collectRequirementCoverage([{ annotations: [] }])).toEqual({
      coveredRequirements: ["SYNTHETIC-BROWSER-SMOKE"],
      invalidAnnotations: [],
    });
  });

  it("fails closed for invalid requirement values and missing viewport/test attachments", () => {
    expect(collectRequirementCoverage([
      { annotations: [{ type: "requirement", description: "manual-editing" }] },
    ])).toEqual({
      coveredRequirements: [],
      invalidAnnotations: ["manual-editing"],
    });
    expect(validateEvidenceAttachments({
      requiredViewports: REQUIRED_SYNTHETIC_VIEWPORTS,
      tests: [{
        id: "desktop-only",
        viewport: "desktop-1440",
        screenshotCount: 1,
        consoleCount: 1,
        networkCount: 0,
      }],
    })).toMatchObject({
      complete: false,
      missingViewports: ["mobile-390", "mobile-320"],
      incompleteTests: ["desktop-only"],
    });
  });

  it("collects R7/R8/R9 from tests and preserves multiple screenshots for one viewport", async () => {
    const evidence = await evidenceRoot();
    const tests = [
      fakeTest("desktop-1440", "fresh hierarchy", ["R7", "R9"]),
      fakeTest("desktop-1440", "dirty navigation", ["R8"]),
      fakeTest("mobile-390", "mobile flow", ["R7", "R8", "R9"]),
      fakeTest("mobile-320", "small mobile flow", ["R7", "R8", "R9"]),
    ];
    const reporter = new EvidenceReporter();
    reporter.onBegin({} as never, { allTests: () => tests } as never);
    reporter.onTestEnd(tests[0] as never, fakeResult("browser-screenshot:fresh") as never);
    reporter.onTestEnd(tests[1] as never, fakeResult("browser-screenshot:guard") as never);
    reporter.onTestEnd(tests[2] as never, fakeResult() as never);
    reporter.onTestEnd(tests[3] as never, fakeResult() as never);

    await expect(reporter.onEnd({ status: "passed" } as never)).resolves.toEqual({});
    const manifest = JSON.parse(await readFile(join(evidence, "manifest.json"), "utf8"));
    expect(manifest.coveredRequirements).toEqual(["R7", "R8", "R9"]);
    expect(manifest.browser.fixtureId).toBe("ai-note-synthetic-library-v1");
    expect(manifest.browser.artifacts.screenshots).toHaveLength(4);
    expect(manifest.browser.artifacts.screenshots.filter(
      (item: { viewport: string }) => item.viewport === "desktop-1440",
    )).toHaveLength(2);
    expect(new Set(manifest.browser.artifacts.screenshots.map(
      (item: { path: string }) => item.path,
    )).size).toBe(4);
  });

  it("marks the run failed when a required viewport or automatic attachment is missing", async () => {
    await evidenceRoot();
    const tests = REQUIRED_SYNTHETIC_VIEWPORTS.map((project) => (
      fakeTest(project, `${project} flow`, ["R9"])
    ));
    const reporter = new EvidenceReporter();
    reporter.onBegin({} as never, { allTests: () => tests } as never);
    reporter.onTestEnd(tests[0] as never, fakeResult() as never);
    reporter.onTestEnd(tests[1] as never, {
      ...fakeResult(),
      attachments: [
        attachment("browser-screenshot", Buffer.from("synthetic-png")),
        attachment("browser-network", { externalRequests: [] }),
      ],
    } as never);

    await expect(reporter.onEnd({ status: "passed" } as never)).resolves.toEqual({ status: "failed" });
  });
});
