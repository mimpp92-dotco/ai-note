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
  private readonly screenshots = new Map<string, Buffer>();
  private readonly consoleProjects = new Set<string>();
  private readonly networkProjects = new Set<string>();
  private readonly consoleErrors: string[] = [];
  private readonly externalRequests: string[] = [];
  private readonly tests: Array<{ project: string; title: string; status: string; errors: string[] }> = [];
  private expectedProjects: string[] = [];

  onBegin(_config: FullConfig, suite: Suite): void {
    this.expectedProjects = [...new Set(
      suite.allTests().map((test) => test.parent.project()?.name ?? "unknown"),
    )];
    prepareEvidenceRoot(this.evidenceRoot, this.runnerOwned);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.parent.project()?.name ?? "unknown";
    this.tests.push({
      project,
      title: test.titlePath().join(" › "),
      status: result.status,
      errors: result.errors.map((error) => error.message ?? String(error)),
    });

    for (const attachment of result.attachments) {
      if (attachment.name === "browser-screenshot") {
        const body = bytesForAttachment(attachment);
        if (body) this.screenshots.set(project, body);
      }
      if (attachment.name === "browser-console") {
        this.consoleProjects.add(project);
        const parsed = parseAttachmentJson(attachment) as { errors?: unknown } | null;
        if (Array.isArray(parsed?.errors)) {
          this.consoleErrors.push(...parsed.errors.filter((item): item is string => typeof item === "string"));
        }
      }
      if (attachment.name === "browser-network") {
        this.networkProjects.add(project);
        const parsed = parseAttachmentJson(attachment) as { externalRequests?: unknown } | null;
        if (Array.isArray(parsed?.externalRequests)) {
          this.externalRequests.push(
            ...parsed.externalRequests.filter((item): item is string => typeof item === "string"),
          );
        }
      }
    }
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult["status"] }> {
    const artifactsRoot = join(this.evidenceRoot, "artifacts");
    const screenshotRecords: ScreenshotRecord[] = [];
    for (const project of this.expectedProjects) {
      const body = this.screenshots.get(project);
      if (!body) continue;
      const path = join(artifactsRoot, `${safeName(project)}.png`);
      writeFileSync(path, body, { mode: 0o600 });
      screenshotRecords.push({ viewport: project, ...this.record(path) });
    }

    const completeProjects = this.expectedProjects.length > 0 && this.expectedProjects.every(
      (project) => this.screenshots.has(project)
        && this.consoleProjects.has(project)
        && this.networkProjects.has(project),
    );
    const passed = result.status === "passed"
      && completeProjects
      && this.consoleErrors.length === 0
      && this.externalRequests.length === 0;
    const assertionsPath = join(artifactsRoot, "assertions.json");
    const consolePath = join(artifactsRoot, "console.json");
    writeFileSync(
      assertionsPath,
      JSON.stringify({
        passed,
        expectedProjects: this.expectedProjects,
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

    const coveredRequirements = (process.env.AI_NOTE_E2E_REQUIREMENTS ?? "SYNTHETIC-BROWSER-SMOKE")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const manifest = {
      schemaVersion: 1,
      coveredRequirements,
      browser: {
        backend: "playwright",
        fixture: "synthetic",
        fixtureId: "ai-note-empty-library-v1",
        fixtureRoot: "artifacts",
        viewports: this.expectedProjects,
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
