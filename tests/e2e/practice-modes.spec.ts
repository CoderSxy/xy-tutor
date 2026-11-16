import { test, expect, type Page } from "@playwright/test";
import { mockLearningApi } from "./fixtures/ui-api";

async function login(page: Page) {
  await page.getByLabel("账号", { exact: true }).fill("student");
  await page.getByLabel("密码", { exact: true }).fill("long-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

async function startPractice(page: Page, width: number) {
  await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
  await mockLearningApi(page, "student", { practiceSets: true });
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "每日5练" }).click();
  await expect(page).toHaveURL(/\/study\//);
  await expect(page.getByRole("heading", { name: "第 1 题" })).toBeVisible();
}

test("phone first visit uses step mode and does not submit on option click", async ({
  page,
}) => {
  await startPractice(page, 390);
  await expect(page.getByRole("button", { name: "逐题作答" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("radio", { name: "2" })).toBeVisible();
  await page.getByRole("radio", { name: "2" }).click();
  await expect(page.getByRole("button", { name: "提交本题" })).toBeEnabled();
  await expect(page.getByText("已提交 1 题", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "提交本题" }).click();
  await expect(page.getByText("批改排队中")).toBeVisible();
  await expect(page.getByRole("button", { name: "再来五题" })).toHaveCount(0);
});

test("wide screen first visit uses batch and keeps independent drafts", async ({
  page,
}) => {
  await startPractice(page, 1440);
  await expect(page.getByRole("button", { name: "整组作答" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("heading", { name: "第 1 题" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "第 5 题" })).toBeVisible();
  await page.getByRole("radio", { name: "2" }).click();
  await page.getByRole("radio", { name: "4" }).click();
  await page.getByPlaceholder("填写答案").nth(0).fill("6");
  await page.getByPlaceholder("填写答案").nth(1).fill("8");
  await page.getByPlaceholder("写出关键步骤").fill("先算 5 再加 5，得 10。");
  await expect(page.getByRole("button", { name: "提交本题" })).toHaveCount(0);
  await page.getByRole("button", { name: "整组作答" }).click();
  await page.getByRole("button", { name: "逐题作答" }).click();
  await expect(page.getByRole("radio", { name: "2" })).toBeChecked();
  await page.reload();
  await expect(page.getByRole("heading", { name: "第 1 题" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "2" })).toBeChecked();
  await page.getByRole("button", { name: "第 5 题", exact: true }).click();
  await expect(page.getByPlaceholder("写出关键步骤")).toHaveValue(
    "先算 5 再加 5，得 10。",
  );
});

test("asking the teacher keeps drafts and does not count as a submission", async ({
  page,
}) => {
  await startPractice(page, 390);
  await page.getByRole("radio", { name: "2" }).click();
  await page.getByLabel("作答意图").selectOption("question");
  await page.getByLabel("你的回答").fill("这题我想先问一下思路。");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByText("模型尚未配置").first()).toBeVisible();
  await expect(page.getByRole("radio", { name: "2" })).toBeChecked();
  await expect(page.getByText("批改排队中")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "再来五题" })).toHaveCount(0);
});

test("draft version conflict tells the student to keep the server copy", async ({
  page,
}) => {
  await startPractice(page, 390);
  await page.getByRole("radio", { name: "2" }).click();
  await page.waitForTimeout(900);
  await page.route("**/api/practice-sets/**/drafts/**", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "CONFLICT", message: "草稿已更新，请刷新后重试" },
        }),
      });
      return;
    }
    await route.fallback();
  });
  await page.getByRole("radio", { name: "1" }).click();
  await expect(page.getByRole("alert")).toContainText("其他标签页");
});
