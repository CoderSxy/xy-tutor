import { expect, test, type Page } from "@playwright/test";
import { mockLearningApi, taskId } from "./fixtures/ui-api";

async function enterStudy(page: Page) {
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill("student");
  await page.getByLabel("密码", { exact: true }).fill("long-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "每日5练" }).click();
  await expect(page).toHaveURL(/\/study\//);
}

test("stops the switching animation after the session data arrives", async ({ page }) => {
  await mockLearningApi(page);
  await enterStudy(page);
  await expect(page.getByRole("button", { name: "结束本次学习" })).toBeVisible();
  await expect(page.locator(".study-main")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".study-main.is-switching")).toHaveCount(0);
});

test("contains the loading animation at every point without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockLearningApi(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/tasks/${taskId}/items*`, async (route) => {
    await gate;
    await route.fulfill({ json: [] });
  });
  try {
    await enterStudy(page);
    await expect(page.locator(".study-main")).toHaveAttribute("aria-busy", "true");
    for (const time of [150, 400, 800, 1100]) {
      const overflow = await page.evaluate((currentTime) => {
        for (const animation of document.getAnimations()) {
          if ((animation as CSSAnimation).animationName === "study-switch-bar") {
            animation.pause();
            animation.currentTime = currentTime;
          }
        }
        return document.documentElement.scrollWidth - window.innerWidth;
      }, time);
      expect(overflow).toBeLessThanOrEqual(1);
    }
  } finally { release(); }
  await expect(page.locator(".study-main")).toHaveAttribute("aria-busy", "false");
});

test("stops loading and shows the failure when the question request fails", async ({ page }) => {
  await mockLearningApi(page);
  await page.route(`**/api/tasks/${taskId}/items*`, (route) => route.fulfill({
    status: 503,
    json: { error: { code: "UNAVAILABLE", message: "题目暂时无法加载" } },
  }));
  await enterStudy(page);
  await expect(page.locator(".study-main")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("alert")).toContainText("题目暂时无法加载");
});
