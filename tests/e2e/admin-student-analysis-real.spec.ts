import { expect, test, type Page } from "@playwright/test";

async function login(page: Page, account: string) {
  await page.getByLabel("账号", { exact: true }).fill(account);
  await page.getByLabel("密码", { exact: true }).fill("e2e-only-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

test("real API: 生成报告、轮询完成并打开证据，跨学生不可读取", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.goto("/admin/students");
  await login(page, "e2e-admin");
  await expect(
    page.getByRole("heading", { name: "端到端测试同学" }),
  ).toBeVisible();

  const otherHref = await page
    .locator(".insight-student", { hasText: "端到端同学乙" })
    .getByRole("link", { name: "查看学情" })
    .getAttribute("href");
  const otherStudentId = otherHref?.split("/")[3];
  expect(otherStudentId).toBeTruthy();

  await page
    .locator(".insight-student", { hasText: "端到端测试同学" })
    .getByRole("link", { name: "查看学情" })
    .click();
  await page.waitForURL("**/overview**");

  await page.getByRole("link", { name: "AI 分析" }).click();
  await page.waitForURL("**/analysis**");
  await expect(
    page.getByRole("heading", { name: "生成学情报告" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "生成学情报告" }).click();
  await page.waitForURL("**/analysis/*");
  const reportPath = new URL(page.url()).pathname;

  await expect(page.getByText("已完成", { exact: true })).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByText("端到端测试报告：已读取本期练习记录。")).toBeVisible();
  await expect(page.getByText("继续巩固分数加法。")).toBeVisible();
  await expect(page.getByText("端到端测试数据，仅用于流程验证。")).toBeVisible();

  await page.getByRole("button", { name: "查看证据" }).first().click();
  await page.waitForURL("**/records/*");
  await expect(page.getByRole("heading", { name: "分数练习" })).toBeVisible();

  await page.goto(reportPath);
  await expect(page.getByText("端到端测试报告：已读取本期练习记录。")).toBeVisible();

  await page.goto(
    `/admin/students/${encodeURIComponent(otherStudentId!)}/analysis/${reportPath.split("/").at(-1)}`,
  );
  await expect(page.getByText("404 · 未找到该学生或记录")).toBeVisible();
});
