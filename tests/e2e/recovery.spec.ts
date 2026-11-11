import { test, expect } from "@playwright/test";
import { mockLearningApi } from "./fixtures/ui-api";
test("a retry after a lost response keeps the same request key", async ({
  page,
}) => {
  await mockLearningApi(page);
  const keys: string[] = [];
  await page.route("**/api/conversations/*/runs*", async (route) => {
    keys.push(route.request().postDataJSON().requestKey);
    await route.abort("failed");
  });
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill("student");
  await page.getByLabel("密码", { exact: true }).fill("long-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "每日5练" }).click();
  await expect(page).toHaveURL(/\/study\//);
  await expect(
    page.getByRole("button", { name: "开始本次辅导" }),
  ).toBeVisible();
  await page.getByLabel("你的回答").fill("开始学习");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[0]).toBe(keys[1]);
});
