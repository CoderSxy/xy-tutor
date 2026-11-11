import { test, expect } from "@playwright/test";
import { mockLearningApi } from "./fixtures/ui-api";
for (const width of [360, 390, 768, 1024, 1280, 1440])
  test(`workbench at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockLearningApi(page);
    await page.route("**/api/materials*", (r) => r.fulfill({ json: [] }));
    await page.goto("/");
    await page.getByLabel("账号", { exact: true }).fill("student");
    await page.getByLabel("密码", { exact: true }).fill("long-password");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "选一个方向，或者直接说出来。" }),
    ).toBeVisible();
    await page.screenshot({
      path: `docs/qa/screenshots/home-${width}.png`,
      fullPage: true,
    });
    for (const path of ["/materials", "/profile", "/history", "/mistakes"]) {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
    }
    await page.goto("/");
    await page.getByRole("button", { name: "每日5练", exact: true }).click();
    await expect(page).toHaveURL(/\/study\//);
    await expect(page.getByLabel("你的回答")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: `docs/qa/screenshots/study-${width}.png`,
      fullPage: true,
    });
  });
