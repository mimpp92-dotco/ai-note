import type { Locator, Page, TestInfo } from "@playwright/test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "./support/synthetic-test";

type ManualEditingFixtureModule = typeof import("../scripts/e2e-manual-editing-fixture.mjs");

const importRuntimeModule = new Function(
  "specifier",
  "return import(specifier)",
) as (specifier: string) => Promise<ManualEditingFixtureModule>;
const fixtureModule = importRuntimeModule(pathToFileURL(join(
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

test("manual transcript and summary editing keeps hierarchy, freshness, and navigation loss explicit", {
  annotation: [
    { type: "requirement", description: "R1" },
    { type: "requirement", description: "R2" },
    { type: "requirement", description: "R3" },
    { type: "requirement", description: "R5" },
    { type: "requirement", description: "R6" },
    { type: "requirement", description: "R7" },
  ],
}, async ({ page }, testInfo) => {
  const {
    MANUAL_EDITING_WORKSPACE_ID,
    manualEditingMeetingForProject,
  } = await fixtureModule;
  const fixture = manualEditingMeetingForProject(testInfo.project.name);
  const detailPath = `/meetings/${fixture.meetingId}?sourceWorkspace=${MANUAL_EDITING_WORKSPACE_ID}&sourceView=all`;
  const generationRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST"
      && (path.endsWith("/transcript/regenerate") || path.endsWith("/summarize"))
    ) generationRequests.push(path);
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /· 모든 회의$/u })).toBeVisible();
  const detailLink = page.getByRole("link").filter({ hasText: fixture.title });
  await expect(detailLink).toHaveAttribute("href", detailPath);
  await detailLink.click();
  await expect(page.getByRole("heading", { name: fixture.title })).toBeVisible();
  await expect(page.getByRole("tab", { name: "회의록 요약", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText(
    "합성 회의에서 수동 편집과 안전한 이탈 보호를 검증한다.",
    { exact: true },
  )).toBeVisible();
  await page.getByRole("tab", { name: "전체 스크립트", exact: true }).click();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });

  const globalActions = page.getByRole("group", { name: "회의 작업" });
  await expect(globalActions.getByRole("button", { name: "회의 이동" })).toBeVisible();
  await expect(globalActions.getByRole("button", { name: "폴더 열기" })).toBeVisible();
  await expect(globalActions.getByRole("link", { name: "회의록 다운로드(.md)" })).toBeVisible();
  await expect(globalActions.getByRole("button")).toHaveCount(2);
  await expect(globalActions.getByRole("link")).toHaveCount(1);
  await expect(globalActions.getByRole("button", { name: /다시 요약|다시 만들기/ })).toHaveCount(0);

  const scriptActions = page.getByRole("group", { name: "전체 스크립트 작업" });
  await expect(scriptActions.getByRole("button", { name: "전체 스크립트 복사" })).toBeVisible();
  await expect(scriptActions.getByRole("button", { name: "전체 스크립트 수정" })).toBeVisible();
  await expect(scriptActions.getByRole("button", { name: "원문에서 스크립트 다시 만들기" })).toBeVisible();
  await expect(scriptActions.getByRole("button")).toHaveCount(3);
  expect(await scriptActions.getByRole("button").allTextContents()).toEqual([
    "전체 스크립트 복사",
    "전체 스크립트 수정",
    "원문에서 스크립트 다시 만들기",
  ]);
  expect(await scriptActions.evaluate((actions) => {
    const panel = actions.closest('[role="tabpanel"]');
    const readBody = panel?.querySelector("[data-confirmed-content='transcript']");
    return Boolean(readBody && (actions.compareDocumentPosition(readBody) & Node.DOCUMENT_POSITION_FOLLOWING));
  })).toBe(true);
  await expectMinimumTarget(scriptActions.getByRole("button"));
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
  await attachMilestone(
    page,
    testInfo,
    testInfo.project.name === "desktop-1440" ? "desktop-fresh" : `${testInfo.project.name}-actions-overflow`,
  );

  const originalTranscript = await page.locator("[data-confirmed-content='transcript']").textContent();
  await scriptActions.getByRole("button", { name: "전체 스크립트 수정" }).click();
  const transcriptEditor = page.getByRole("textbox", { name: "전체 스크립트" });
  await expect(transcriptEditor).toBeFocused();
  await expect(page.locator("[data-confirmed-content='transcript']")).toHaveCount(0);
  await transcriptEditor.fill("취소로 버릴 임시 스크립트");
  await page.getByRole("button", { name: "수정 취소" }).click();
  const continueEditing = page.getByRole("button", { name: "계속 수정" });
  await expect(continueEditing).toBeFocused();
  await expect(transcriptEditor).toHaveValue("취소로 버릴 임시 스크립트");
  await page.getByRole("button", { name: "수정 내용 버리기" }).click();
  await expect(transcriptEditor).toHaveCount(0);
  await expect(page.locator("[data-confirmed-content='transcript']")).toHaveText(originalTranscript ?? "");

  const transcriptDraft = `수동 저장된 ${testInfo.project.name} 스크립트\n둘째 줄도 그대로 보존됩니다.`;
  await scriptActions.getByRole("button", { name: "전체 스크립트 수정" }).click();
  await expect(transcriptEditor).toBeFocused();
  await transcriptEditor.fill(transcriptDraft);
  await expect(page.getByText(/전체 스크립트 복사와 회의록 다운로드는 마지막으로 확인된 저장 내용을 사용합니다/u))
    .toBeVisible();
  await scriptActions.getByRole("button", { name: "전체 스크립트 복사" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(originalTranscript);
  await page.getByRole("button", { name: "전체 스크립트 저장" }).click();
  await expect(transcriptEditor).toHaveCount(0);
  await expect(page.getByText(transcriptDraft, { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /회의록 요약.*요약 갱신 필요/ })).toBeVisible();
  await page.getByRole("button", { name: "전체 스크립트 복사" }).click();
  await expect(page.getByText("복사됨", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(transcriptDraft);
  await attachMilestone(page, testInfo, `${testInfo.project.name}-stale-summary`);

  await page.getByRole("tab", { name: /회의록 요약/ }).click();
  await expect(page.getByText("합성 회의에서 수동 편집과 안전한 이탈 보호를 검증한다.", {
    exact: true,
  })).toBeVisible();
  const summaryActions = page.getByRole("group", { name: "회의록 요약 작업" });
  await expect(summaryActions.getByRole("button", { name: "요약 복사" })).toBeVisible();
  await expect(summaryActions.getByRole("link", { name: "JSON 다운로드" })).toBeVisible();
  await expect(summaryActions.getByRole("button", { name: "회의록 요약 수정" })).toBeVisible();
  await expect(summaryActions.getByRole("button", { name: "현재 스크립트로 요약 다시 만들기" })).toBeVisible();
  await expect(summaryActions.getByRole("button")).toHaveCount(3);
  await expect(summaryActions.getByRole("link")).toHaveCount(1);
  expect(await summaryActions.locator("button, a").allTextContents()).toEqual([
    "요약 복사",
    "JSON 다운로드",
    "회의록 요약 수정",
    "현재 스크립트로 요약 다시 만들기",
  ]);
  await expectMinimumTarget(summaryActions.getByRole("button"));
  await expectMinimumTarget(summaryActions.getByRole("link"));

  await summaryActions.getByRole("button", { name: "회의록 요약 수정" }).click();
  const summaryEditor = page.getByRole("textbox", { name: "회의록 요약 본문" });
  const projectedBody = await summaryEditor.inputValue();
  expect(projectedBody).toContain("요약\n");
  expect(projectedBody.endsWith("\n")).toBe(false);
  await expect(page.getByRole("textbox")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /추가|삭제/u })).toHaveCount(0);
  const editedSummaryBody = projectedBody
    .replace(/^요약\n/u, "")
    .replace("합성 회의에서 수동 편집과 안전한 이탈 보호를 검증한다.", `수동 저장된 ${testInfo.project.name} 요약`);
  await summaryEditor.fill(editedSummaryBody);
  await expect(page.getByText(/요약 복사, JSON 다운로드와 회의록 다운로드는 마지막으로 확인된 저장 내용을 사용합니다/u))
    .toBeVisible();
  await page.getByRole("button", { name: "회의록 요약 저장" }).click();
  await expect(summaryEditor).toHaveCount(0);
  await expect(page.locator("[data-confirmed-content='summary']")).toHaveText(editedSummaryBody);
  await expect(page.locator("[data-confirmed-content='summary']")).not.toContainText(/^요약$/u);
  await expect(page.getByRole("tab", { name: "회의록 요약", exact: true })).toBeVisible();
  await expect(page.getByText("요약 갱신 필요", { exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "전체 스크립트", exact: true }).click();
  await expect(page.getByText(transcriptDraft, { exact: true })).toBeVisible();

  const transcriptGeneration = page.getByRole("button", { name: "원문에서 스크립트 다시 만들기" });
  await transcriptGeneration.click();
  const transcriptCancel = page.getByRole("button", { name: "취소" });
  await expect(transcriptCancel).toBeFocused();
  await expect(page.getByRole("dialog", { name: "전체 스크립트 다시 만들기" }))
    .toContainText("현재 스크립트는 대체되고 기존 요약은 유지");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "전체 스크립트 다시 만들기" })).toHaveCount(0);
  await expect(transcriptGeneration).toBeFocused();

  await page.getByRole("tab", { name: "회의록 요약", exact: true }).click();
  const summaryGeneration = page.getByRole("button", { name: "현재 스크립트로 요약 다시 만들기" });
  await summaryGeneration.click();
  await expect(page.getByRole("button", { name: "취소" })).toBeFocused();
  await expect(page.getByRole("dialog", { name: "회의록 요약 다시 만들기" }))
    .toContainText("스크립트는 바뀌지 않고 현재 수동 요약은 대체");
  await page.keyboard.press("Escape");
  await expect(summaryGeneration).toBeFocused();
  expect(generationRequests).toEqual([]);

  await page.getByRole("tab", { name: "전체 스크립트", exact: true }).click();
  await page.getByRole("button", { name: "전체 스크립트 수정" }).click();
  const dirtyDraft = `이탈 전 보존할 ${testInfo.project.name} draft`;
  await page.getByRole("textbox", { name: "전체 스크립트" }).fill(dirtyDraft);
  const detailBack = page.getByRole("link", { name: /목록/ });
  await detailBack.click();
  const guard = page.getByRole("dialog", { name: "수정 내용이 저장되지 않았습니다" });
  await expect(guard).toBeVisible();
  await expect(guard).toContainText("전체 스크립트 수정");
  await expect(page.getByRole("textbox", { name: "전체 스크립트" })).toHaveValue(dirtyDraft);
  await expect(page.getByRole("button", { name: "계속 편집" })).toBeFocused();
  await attachMilestone(page, testInfo, `${testInfo.project.name}-navigation-guard`);
  await page.getByRole("button", { name: "계속 편집" }).click();
  await expect(detailBack).toBeFocused();
  await expect(page.getByRole("textbox", { name: "전체 스크립트" })).toHaveValue(dirtyDraft);

  if (testInfo.project.name !== "desktop-1440") {
    await page.getByRole("button", { name: "라이브러리 메뉴 열기" }).click();
  }
  const settingsLink = page.getByRole("link", { name: "설정", exact: true });
  await settingsLink.click();
  await expect(guard).toBeVisible();
  await page.getByRole("button", { name: "계속 편집" }).click();
  await expect(settingsLink).toBeFocused();
  await expect(page.getByRole("textbox", { name: "전체 스크립트" })).toHaveValue(dirtyDraft);
  if (testInfo.project.name !== "desktop-1440") {
    await page.getByRole("button", { name: "라이브러리 메뉴 닫기" }).click();
  }

  await page.evaluate(() => {
    const tracked = window as typeof window & { __syntheticHistoryBackCount?: number };
    const originalBack = window.history.back.bind(window.history);
    tracked.__syntheticHistoryBackCount = 0;
    window.history.back = () => {
      tracked.__syntheticHistoryBackCount = (tracked.__syntheticHistoryBackCount ?? 0) + 1;
      originalBack();
    };
  });
  await page.evaluate(() => window.history.back());
  await expect(guard).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/meetings/${fixture.meetingId}`));
  await expect(page.getByRole("textbox", { name: "전체 스크립트" })).toHaveValue(dirtyDraft);
  await page.evaluate(() => {
    (window as typeof window & { __syntheticHistoryBackCount?: number })
      .__syntheticHistoryBackCount = 0;
  });
  await page.getByRole("button", { name: "수정 내용 버리고 이동" }).click();
  await page.waitForFunction(() => window.location.pathname === "/");
  expect(await page.evaluate(() => (
    (window as typeof window & { __syntheticHistoryBackCount?: number }).__syntheticHistoryBackCount
  ))).toBe(1);
  await expect(page.getByRole("heading", { level: 1, name: /· 모든 회의$/u })).toBeVisible();
});
