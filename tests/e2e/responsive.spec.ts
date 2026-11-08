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
    await page.getByLabel("教材版本").selectOption("人教版");
    await page.getByLabel("年级", { exact: true }).selectOption("五年级");
    await page.getByLabel("科目", { exact: true }).selectOption("数学");
    await page.getByRole("button", { name: "进入学习空间" }).click();
    await expect(
      page.getByRole("heading", { name: "今天，从哪里开始？" }),
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
    await page.getByRole("button", { name: "开始每日5练" }).click();
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
