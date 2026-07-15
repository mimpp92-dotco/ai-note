import { expect, test } from "./support/synthetic-test";

test("synthetic library shell is usable without external traffic", async ({ page }) => {
  const libraryResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/library"
  ));
  const whisperResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/whisper/health"
  ));
  const llmResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/settings/llm/health"
  ));
  await page.goto("/");
  const libraryResponse = await libraryResponsePromise;
  const whisperResponse = await whisperResponsePromise;
  const llmResponse = await llmResponsePromise;

  expect(
    libraryResponse.ok(),
    `synthetic library response status: ${libraryResponse.status()}`,
  ).toBe(true);
  expect(await libraryResponse.json(), "synthetic library state").toMatchObject({
    mode: "ready",
    library: { counts: { visibleMeetingCount: 3 } },
  });
  expect(await whisperResponse.json(), "synthetic Whisper state").toMatchObject({ connected: false });
  expect(await llmResponse.json(), "synthetic LLM state").toEqual({ configured: false });
  await expect(page).toHaveTitle("AI NOTE");
  await expect(page.locator("main#main")).toBeVisible();
  await expect(page.getByText("회의 녹음 → 로컬 전사 → 회의록 요약.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "모든 회의", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "회의 목록" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "아직 회의록이 없습니다" })).toHaveCount(0);
});
