import type { Locator, Page, Route, TestInfo } from "@playwright/test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "./support/synthetic-test";

type FirstRunFixtureModule = typeof import("../scripts/e2e-first-run-fixture.mjs");
type ManualEditingFixtureModule = typeof import("../scripts/e2e-manual-editing-fixture.mjs");
type Provider = "claude-cli" | "codex-cli" | "ollama";
type SettingsState = {
  provider: Provider;
  model?: string;
  baseUrl?: string;
} | null;
type WhisperModel = "large-v3" | "large-v3-turbo";
type PipelineSettingsState = {
  transcription: { model: WhisperModel };
  correction: { mode: "full" | "fast" };
};

const importRuntimeModule = new Function(
  "specifier",
  "return import(specifier)",
) as <Module>(specifier: string) => Promise<Module>;
const firstRunFixtureModule = importRuntimeModule<FirstRunFixtureModule>(pathToFileURL(join(
  __dirname,
  "../scripts/e2e-first-run-fixture.mjs",
)).href);
const manualFixtureModule = importRuntimeModule<ManualEditingFixtureModule>(pathToFileURL(join(
  __dirname,
  "../scripts/e2e-manual-editing-fixture.mjs",
)).href);

async function attachMilestone(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(`browser-screenshot:${name}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}

async function expectMinimumTarget(locator: Locator) {
  const boxes = await locator.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { width: box.width, height: box.height };
  }));
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
}

async function fulfillJson(route: Route, value: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}

test("installation first run, provider models, summary default, and transcription recovery stay synthetic", {
  annotation: [
    { type: "requirement", description: "R2" },
    { type: "requirement", description: "R3" },
    { type: "requirement", description: "R4" },
    { type: "requirement", description: "R5" },
    { type: "requirement", description: "R6" },
    { type: "requirement", description: "R7" },
  ],
}, async ({ page }, testInfo) => {
  const { firstRunMeetingForProject } = await firstRunFixtureModule;
  const {
    MANUAL_EDITING_WORKSPACE_ID,
    manualEditingMeetingForProject,
  } = await manualFixtureModule;
  const failureMeeting = firstRunMeetingForProject(testInfo.project.name);
  const completedMeeting = manualEditingMeetingForProject(testInfo.project.name);

  let settingsState: SettingsState = null;
  let pipelineSettings: PipelineSettingsState = {
    transcription: { model: "large-v3" },
    correction: { mode: "full" },
  };
  let pipelineSource: "default" | "stored" = "default";
  const savePayloads: Array<Record<string, unknown>> = [];
  const pipelineSavePayloads: PipelineSettingsState[] = [];
  const preparePayloads: Array<{ model: WhisperModel }> = [];
  const preparation: Record<WhisperModel, "idle" | "preparing" | "ready" | "error"> = {
    "large-v3": "idle",
    "large-v3-turbo": "idle",
  };
  const discoveryPayloads: Array<Record<string, unknown>> = [];
  const healthProviders: Array<Provider | "unconfigured"> = [];
  const transcribePayloads: Array<Record<string, unknown>> = [];
  let releaseTranscribe: (() => void) | null = null;
  const releasePendingTranscribe = () => releaseTranscribe?.();
  let activeMeetingPolls = 0;
  let maximumMeetingPolls = 0;

  await page.route("**/api/settings/llm/health", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    healthProviders.push(settingsState?.provider ?? "unconfigured");
    // Keep the mocked client fetch behind the initial server render so the
    // persistent layout hydrates from the same loading state on every document.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (!settingsState) return fulfillJson(route, { configured: false });
    return fulfillJson(route, {
      configured: true,
      provider: settingsState.provider,
      ...(settingsState.model ? { model: settingsState.model } : {}),
      ok: true,
      detail: settingsState.provider === "ollama"
        ? "합성 Ollama 연결 확인"
        : "합성 CLI 바이너리 감지",
    });
  });
  await page.route("**/api/whisper/health", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return fulfillJson(route, {
      connected: true,
      ok: true,
      ready: true,
      model: pipelineSettings.transcription.model,
      modelPreparation: (["large-v3", "large-v3-turbo"] as const).map((model) => ({
        model,
        status: preparation[model],
      })),
    });
  });
  await page.route("**/api/settings/pipeline", async (route) => {
    if (route.request().method() === "GET") {
      return fulfillJson(route, {
        source: pipelineSource,
        settings: pipelineSettings,
      });
    }
    if (route.request().method() !== "POST") return route.fallback();
    pipelineSettings = route.request().postDataJSON() as PipelineSettingsState;
    pipelineSource = "stored";
    pipelineSavePayloads.push(pipelineSettings);
    return fulfillJson(route, {
      settings: pipelineSettings,
      durability: "durable",
    });
  });
  await page.route("**/api/whisper/models/prepare", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as { model: WhisperModel };
    preparePayloads.push(body);
    preparation[body.model] = "preparing";
    setTimeout(() => {
      preparation[body.model] = "ready";
    }, 100);
    return fulfillJson(route, { model: body.model, status: "preparing" }, 202);
  });
  await page.route("**/api/settings/llm/models", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    discoveryPayloads.push(route.request().postDataJSON() as Record<string, unknown>);
    return fulfillJson(route, { models: ["llama3.2:latest", "synthetic-local:7b"] });
  });
  await page.route("**/api/settings/llm", async (route) => {
    if (route.request().method() === "GET") {
      return fulfillJson(route, settingsState ?? { provider: null });
    }
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    savePayloads.push(body);
    settingsState = {
      provider: body.provider as Provider,
      ...(typeof body.model === "string" ? { model: body.model } : {}),
      ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
    };
    return fulfillJson(route, settingsState);
  });
  await page.route("**/api/settings/profile", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return fulfillJson(route, {
      configured: false,
      defaults: { timezone: "Asia/Seoul", weekStartsOn: "monday" },
    });
  });
  await page.route("**/api/transcribe", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    transcribePayloads.push(route.request().postDataJSON() as Record<string, unknown>);
    await new Promise<void>((resolve) => {
      releaseTranscribe = resolve;
    });
    return fulfillJson(route, {
      id: failureMeeting.meetingId,
      status: "transcribing",
      durability: "durable",
    });
  });
  await page.route(`**/api/meetings/${failureMeeting.meetingId}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    activeMeetingPolls += 1;
    maximumMeetingPolls = Math.max(maximumMeetingPolls, activeMeetingPolls);
    await fulfillJson(route, {
      id: failureMeeting.meetingId,
      status: "recorded",
      error: { action: "retry_transcription", message: "합성 전사 실패" },
    });
    activeMeetingPolls -= 1;
  });

  await page.goto("/");
  const readinessCard = page.getByRole("heading", { name: "회의록 요약을 준비하세요" })
    .locator("..");
  await expect(readinessCard).toContainText(
    "요약 모델이 없어도 회의 녹음과 로컬 전사는 계속 사용할 수 있습니다.",
  );
  const configureSummary = readinessCard.getByRole("link", { name: "AI 요약 설정" });
  const recordWithoutSummary = readinessCard.getByRole("button", {
    name: "요약 없이 회의 녹음",
  });
  const recorderStart = page.getByRole("button", { name: "회의 녹음 시작" });
  await expect(configureSummary).toBeVisible();
  await expect(recordWithoutSummary).toBeVisible();
  await expect(recorderStart).toBeEnabled();
  await expect(page.getByText(
    /선택한 Whisper 모델을 처음 사용하면 먼저 내려받아 시간이 더 걸릴 수 있습니다/u,
  )).toBeVisible();
  await expect(page.getByText(
    /다운로드가 끝나기 전에는 진행률을 표시하지 않습니다/u,
  )).toBeVisible();
  await expectMinimumTarget(readinessCard.locator("a, button"));
  await expectMinimumTarget(recorderStart);
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
  expect(await readinessCard.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await attachMilestone(page, testInfo, `${testInfo.project.name}-home-first-run`);

  await recordWithoutSummary.click();
  await expect(recorderStart).toBeFocused();
  expect(await recorderStart.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= window.innerHeight;
  })).toBe(true);

  settingsState = { provider: "claude-cli", model: "claude-legacy-exact" };
  await page.goto("/settings");
  const pipelineHeading = page.getByRole("heading", { level: 2, name: "전사·교정" });
  const modelHeading = page.getByRole("heading", { level: 2, name: "요약 모델" });
  const profileHeading = page.getByRole("heading", { level: 2, name: "내 정보" });
  await expect(pipelineHeading).toBeVisible();
  await expect(modelHeading).toBeVisible();
  await expect(profileHeading).toBeVisible();
  expect(await modelHeading.evaluate((model) => {
    const profile = document.getElementById("user-profile-heading");
    return Boolean(
      profile
      && (model.compareDocumentPosition(profile) & Node.DOCUMENT_POSITION_FOLLOWING),
    );
  })).toBe(true);
  await expect(page.getByText(
    "내 정보가 없어도 녹음·전사·일반 검색을 사용할 수 있습니다.",
  )).toBeVisible();
  const pipelineSection = page.locator("section[aria-labelledby='pipeline-settings-heading']");
  const whisperModel = pipelineSection.getByLabel("Whisper 모델");
  const correctionMode = pipelineSection.getByLabel("교정 방식");
  await expect(whisperModel).toHaveValue("large-v3");
  await expect(correctionMode).toHaveValue("full");
  expect(await whisperModel.locator("option").allTextContents()).toEqual([
    "large-v3 — 품질 우선(기본)",
    "large-v3-turbo — 더 빠른 후보",
  ]);
  expect(await correctionMode.locator("option").allTextContents()).toEqual([
    "전체 교정 — 품질 우선(기본)",
    "빠른 교정 — 실험적·검증 필요",
  ]);
  await whisperModel.selectOption("large-v3-turbo");
  await correctionMode.selectOption("fast");
  await pipelineSection.getByRole("button", { name: "설정 저장" }).click();
  await expect(pipelineSection.getByRole("status", { name: "전사·교정 설정 상태" }))
    .toContainText("저장됨");
  expect(pipelineSavePayloads).toEqual([{
    transcription: { model: "large-v3-turbo" },
    correction: { mode: "fast" },
  }]);
  expect(preparePayloads).toEqual([]);

  const prepare = pipelineSection.getByRole("button", { name: "선택 모델 미리 준비" });
  await prepare.click();
  await expect(pipelineSection.getByRole("status", { name: "Whisper 모델 준비 상태" }))
    .toContainText(/large-v3-turbo 모델 준비 (?:중|완료)/u);
  expect(preparePayloads).toEqual([{ model: "large-v3-turbo" }]);
  await expectMinimumTarget(prepare);
  const modelSettings = page.locator("section[aria-labelledby='llm-settings-heading']");

  const modelSelect = page.getByLabel("모델", { exact: true });
  await expect(modelSelect).toHaveValue("__custom__");
  await expect(page.getByLabel("직접 입력 모델")).toHaveValue("claude-legacy-exact");
  expect(await modelSelect.locator("option").allTextContents()).toEqual([
    "CLI 기본값 (권장)",
    "Sonnet",
    "Opus",
    "Haiku",
    "직접 입력",
  ]);

  await modelSelect.selectOption("sonnet");
  await page.getByRole("radio", { name: /Codex CLI/u }).check();
  expect(await modelSelect.locator("option").allTextContents()).toEqual([
    "CLI 기본값 (권장)",
    "직접 입력",
  ]);
  await modelSelect.selectOption("__custom__");
  await page.getByLabel("직접 입력 모델").fill("  codex-synthetic-exact  ");
  await page.getByRole("radio", { name: /Claude CLI/u }).check();
  await expect(modelSelect).toHaveValue("sonnet");
  await page.getByRole("radio", { name: /Codex CLI/u }).check();
  await expect(page.getByLabel("직접 입력 모델")).toHaveValue("  codex-synthetic-exact  ");

  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(modelSettings.getByText(/Codex CLI codex-synthetic-exact · 감지됨/u)).toBeVisible();
  expect(savePayloads.at(-1)).toEqual({
    provider: "codex-cli",
    model: "codex-synthetic-exact",
  });
  expect(healthProviders).toContain("codex-cli");
  await expect(page.getByRole("link", { name: "첫 회의 녹음" })).toBeVisible();

  await page.getByRole("radio", { name: /Ollama/u }).check();
  await expect.poll(() => discoveryPayloads.length).toBeGreaterThan(0);
  await page.getByLabel("Base URL (선택)").fill("http://127.0.0.1:11434");
  await page.getByRole("button", { name: "설치된 모델 새로고침" }).click();
  await expect.poll(() => discoveryPayloads.length).toBeGreaterThan(1);
  expect(discoveryPayloads.at(-1)).toEqual({ baseUrl: "http://127.0.0.1:11434" });
  await expect(modelSelect.locator("option")).toHaveText([
    "llama3.2:latest",
    "synthetic-local:7b",
    "직접 입력",
  ]);
  await modelSelect.selectOption("llama3.2:latest");
  await modelSelect.selectOption("__custom__");
  await page.getByLabel("직접 입력 모델").fill("  local-custom:7b  ");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(modelSettings.getByText(/Ollama local-custom:7b · 연결됨/u)).toBeVisible();
  expect(savePayloads.at(-1)).toEqual({
    provider: "ollama",
    model: "local-custom:7b",
    baseUrl: "http://127.0.0.1:11434",
  });
  expect(healthProviders).toContain("ollama");
  await expect(page.getByRole("link", { name: "첫 회의 녹음" })).toBeVisible();
  await expectMinimumTarget(page.getByRole("button", { name: "설치된 모델 새로고침" }));
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
  await attachMilestone(page, testInfo, `${testInfo.project.name}-settings-models`);

  await page.goto(`/meetings/${completedMeeting.meetingId}`);
  await expect(page.getByRole("tab", { name: "회의록 요약", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText(
    "합성 회의에서 수동 편집과 안전한 이탈 보호를 검증한다.",
    { exact: true },
  )).toBeVisible();
  await page.goto(`/meetings/${completedMeeting.meetingId}?contentTab=script`);
  await expect(page.getByRole("tab", { name: "전체 스크립트", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.goto("/");
  const failureRow = page.getByRole("link").filter({ hasText: failureMeeting.title });
  await expect(failureRow).toContainText("전사 실패");
  const failureDetailPath = `/meetings/${failureMeeting.meetingId}?sourceWorkspace=${MANUAL_EDITING_WORKSPACE_ID}&sourceView=all`;
  await expect(failureRow).toHaveAttribute("href", failureDetailPath);
  await page.goto(failureDetailPath);
  await expect(page.getByRole("heading", { name: failureMeeting.title })).toBeVisible();
  await expect(page.getByText("전사 실패", { exact: true }).first()).toBeVisible();
  const retry = page.getByRole("button", { name: /^전사 (?:다시 시도|요청 중…)$/u });
  await expect(retry).toBeVisible();
  await expectMinimumTarget(retry);
  await retry.click();
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveText("전사 요청 중…");
  expect(transcribePayloads).toEqual([{ id: failureMeeting.meetingId }]);
  releasePendingTranscribe();
  await expect(page.getByRole("status", { name: "전사 다시 시도 상태" })).toContainText(
    "전사 요청을 접수했습니다.",
  );
  await expect(retry).toBeFocused();
  await expect.poll(() => maximumMeetingPolls).toBe(1);
  expect(maximumMeetingPolls).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
  await attachMilestone(page, testInfo, `${testInfo.project.name}-transcription-retry`);
});
