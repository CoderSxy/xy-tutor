import { test, expect } from "@playwright/test";
import { mockLearningApi } from "./fixtures/ui-api";
test("requires textbook selection and keeps entry actions when model is unavailable", async ({
  page,
}) => {
  await mockLearningApi(page);
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill("student");
  await page.getByLabel("密码", { exact: true }).fill("long-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "选择你的教材" }),
  ).toBeVisible();
  await page.getByLabel("教材版本").selectOption("人教版");
  await page.getByLabel("年级", { exact: true }).selectOption("五年级");
  await page.getByLabel("科目", { exact: true }).selectOption("数学");
  await page.getByRole("button", { name: "进入学习空间" }).click();
  await expect(
    page.getByRole("heading", { name: "今天，从哪里开始？" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "开始每日5练" })).toBeVisible();
  await page.getByRole("button", { name: "开始每日5练" }).click();
  await expect(page.getByLabel("你的回答")).toBeVisible();
  await page.getByLabel("你的回答").fill("我们开始吧");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByRole("alert")).toContainText("模型尚未配置");
  expect(await page.getByLabel("你的回答").inputValue()).toBe("我们开始吧");
});
