import { test, expect } from "@playwright/test";
import { mockLearningApi } from "./fixtures/ui-api";
test("keeps entry actions when the model is unavailable", async ({ page }) => {
  await mockLearningApi(page);
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill("student");
  await page.getByLabel("密码", { exact: true }).fill("long-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "选一个方向，或者直接说出来。" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "每日5练" })).toBeVisible();
  await page.getByRole("button", { name: "每日5练" }).click();
  await expect(page).toHaveURL(/\/study\//);
  await expect(
    page.getByRole("button", { name: "开始本次辅导" }),
  ).toBeVisible();
  await expect(page.getByLabel("你的回答")).toBeVisible();
  await page.getByLabel("你的回答").fill("我们开始吧");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByRole("alert")).toContainText("模型尚未配置");
  expect(await page.getByLabel("你的回答").inputValue()).toBe("我们开始吧");
});
