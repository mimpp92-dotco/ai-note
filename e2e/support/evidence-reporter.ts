import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

import {
  REQUIRED_SYNTHETIC_VIEWPORTS,
  collectRequirementCoverage,
  validateEvidenceAttachments,
  type TestAttachmentCoverage,
} from "./evidence-contract";

interface ArtifactRecord {
  path: string;
  sha256: string;
  bytes: number;
}

interface ScreenshotRecord extends ArtifactRecord {
  viewport: string;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function bytesForAttachment(attachment: TestResult["attachments"][number]): Buffer | null {
  if (attachment.body) return attachment.body;
  if (attachment.path) return readFileSync(attachment.path);
  return null;
}

function parseAttachmentJson(attachment: TestResult["attachments"][number]): unknown {
  const body = bytesForAttachment(attachment);
  if (!body) return null;
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function prepareEvidenceRoot(path: string, runnerOwned: boolean): void {
  const expectedName = runnerOwned ? "playwright-evidence" : "evidence";
  if (basename(path) !== expectedName) {
    throw new Error(`refusing unsafe Playwright evidence root: ${path}`);
  }
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Playwright evidence root must be a real directory: ${path}`);
    }
    for (const entry of readdirSync(path)) rmSync(join(path, entry), { recursive: true, force: true });
  } else {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  chmodSync(path, 0o700);
  mkdirSync(join(path, "artifacts"), { mode: 0o700 });
}

export default class EvidenceReporter implements Reporter {
  private readonly runnerOwned = process.env.AI_EXECUTE_BROWSER_EVIDENCE_DIR !== undefined;
  private readonly evidenceRoot = resolve(
    process.env.AI_EXECUTE_BROWSER_EVIDENCE_DIR ?? "test-results/evidence",
  );
  private readonly screenshots: Array<{
    project: string;
    name: string;
    body: Buffer;
  }> = [];
  private readonly attachmentCoverage: TestAttachmentCoverage[] = [];
  private readonly consoleErrors: string[] = [];
  private readonly externalRequests: string[] = [];
  private readonly tests: Array<{ project: string; title: string; status: string; errors: string[] }> = [];
  private suiteTests: TestCase[] = [];

  onBegin(_config: FullConfig, suite: Suite): void {
    this.suiteTests = suite.allTests();
    prepareEvidenceRoot(this.evidenceRoot, this.runnerOwned);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.parent.project()?.name ?? "unknown";
    const title = test.titlePath().join(" › ");
    const testId = `${project}:${this.tests.length + 1}:${title}`;
    this.tests.push({
      project,
      title,
      status: result.status,
      errors: result.errors.map((error) => error.message ?? String(error)),
    });

    let screenshotCount = 0;
    let consoleCount = 0;
    let networkCount = 0;
    for (const attachment of result.attachments) {
      if (
        attachment.name === "browser-screenshot"
        || attachment.name.startsWith("browser-screenshot:")
      ) {
        const body = bytesForAttachment(attachment);
        if (body) screenshotCount += 1;
        if (body && result.status === "passed") {
          this.screenshots.push({ project, name: attachment.name, body });
        }
      }
      if (attachment.name === "browser-console") {
        const parsed = parseAttachmentJson(attachment) as { errors?: unknown } | null;
        if (Array.isArray(parsed?.errors)) {
          consoleCount += 1;
          this.consoleErrors.push(...parsed.errors.filter((item): item is string => typeof item === "string"));
        }
      }
      if (attachment.name === "browser-network") {
        const parsed = parseAttachmentJson(attachment) as { externalRequests?: unknown } | null;
        if (Array.isArray(parsed?.externalRequests)) {
          networkCount += 1;
          this.externalRequests.push(
            ...parsed.externalRequests.filter((item): item is string => typeof item === "string"),
          );
        }
      }
    }
    this.attachmentCoverage.push({
      id: testId,
      viewport: project,
      screenshotCount,
      consoleCount,
      networkCount,
    });
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult["status"] }> {
    const artifactsRoot = join(this.evidenceRoot, "artifacts");
    const screenshotRecords: ScreenshotRecord[] = [];
    const screenshotIndexes = new Map<string, number>();
    for (const screenshot of this.screenshots) {
      const index = (screenshotIndexes.get(screenshot.project) ?? 0) + 1;
      screenshotIndexes.set(screenshot.project, index);
      const milestone = screenshot.name.split(":", 2)[1] ?? "success";
      const path = join(
        artifactsRoot,
        `${safeName(screenshot.project)}-${String(index).padStart(2, "0")}-${safeName(milestone)}.png`,
      );
      writeFileSync(path, screenshot.body, { mode: 0o600 });
      screenshotRecords.push({ viewport: screenshot.project, ...this.record(path) });
    }

    const attachmentValidation = validateEvidenceAttachments({
      requiredViewports: REQUIRED_SYNTHETIC_VIEWPORTS,
      tests: this.attachmentCoverage,
    });
    const requirementCoverage = collectRequirementCoverage(this.suiteTests);
    const passed = result.status === "passed"
      && attachmentValidation.complete
      && requirementCoverage.invalidAnnotations.length === 0
      && this.consoleErrors.length === 0
      && this.externalRequests.length === 0;
    const assertionsPath = join(artifactsRoot, "assertions.json");
    const consolePath = join(artifactsRoot, "console.json");
    writeFileSync(
      assertionsPath,
      JSON.stringify({
        passed,
        expectedProjects: REQUIRED_SYNTHETIC_VIEWPORTS,
        attachmentValidation,
        invalidRequirementAnnotations: requirementCoverage.invalidAnnotations,
        noConsoleErrors: this.consoleErrors.length === 0,
        noExternalNetwork: this.externalRequests.length === 0,
        externalRequests: this.externalRequests,
        tests: this.tests,
      }, null, 2),
      { mode: 0o600 },
    );
    writeFileSync(
      consolePath,
      JSON.stringify({ errors: this.consoleErrors }, null, 2),
      { mode: 0o600 },
    );

    const manifest = {
      schemaVersion: 1,
      coveredRequirements: requirementCoverage.coveredRequirements,
      browser: {
        backend: "playwright",
        fixture: "synthetic",
        fixtureId: "ai-note-synthetic-library-v1",
        fixtureRoot: "artifacts",
        viewports: REQUIRED_SYNTHETIC_VIEWPORTS,
        assertionsPassed: passed,
        usedRealUserData: false,
        forbiddenRootAccessed: false,
        externalNetworkAccessed: this.externalRequests.length > 0,
        artifacts: {
          screenshots: screenshotRecords,
          assertions: this.record(assertionsPath),
          console: { ...this.record(consolePath), errorCount: this.consoleErrors.length },
        },
      },
    };
    const manifestPath = join(this.evidenceRoot, "manifest.json");
    mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return passed ? {} : { status: "failed" };
  }

  private record(path: string): ArtifactRecord {
    const body = readFileSync(path);
    return {
      path: path.slice(this.evidenceRoot.length + 1).replaceAll("\\", "/"),
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.byteLength,
    };
  }
}
