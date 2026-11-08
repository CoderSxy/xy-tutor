import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
async function pdf() {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([400, 500]).drawText("Fill the value: 1+1=?", {
    font,
    x: 25,
    y: 400,
    size: 16,
  });
  return Buffer.from(await d.save());
}
async function login(page: Page, account: string) {
  await page.getByLabel("账号", { exact: true }).fill(account);
  await page.getByLabel("密码", { exact: true }).fill("e2e-only-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
}
test("real API and PostgreSQL: publish, tutor, correct, import and authorize", async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  await page.goto("/admin/textbooks");
  await login(page, "e2e-admin");
  await page.getByRole("button", { name: "上传电子教材" }).click();
  await page.getByLabel("教材名称").fill("端到端数学教材");
  await page
    .getByLabel("选择上传文件")
    .setInputFiles({
      name: "textbook.pdf",
      mimeType: "application/pdf",
      buffer: await pdf(),
    });
  await page.getByRole("button", { name: "确认上传", exact: true }).click();
  await expect(
    page.getByText("教材原文件已上传并封存，可以创建教材并解析。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "创建教材并解析" }).click();
  await expect(
    page.getByRole("button", { name: "发布教材", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "发布教材", exact: true }).click();
  await expect(page.getByRole("button", { name: "停用教材" })).toBeVisible();
  const context = await browser.newContext();
  const student = await context.newPage();
  await student.goto("http://localhost:5175/");
  await login(student, "e2e-student");
  await student.getByLabel("教材版本").selectOption("人教版");
  await student.getByLabel("年级", { exact: true }).selectOption("五年级");
  await student.getByLabel("科目", { exact: true }).selectOption("数学");
  await student.getByRole("button", { name: "进入学习空间" }).click();
  await student.getByRole("button", { name: "开始每日5练" }).click();
  await student.waitForURL("**/study/*");
  const studyUrl = student.url();
  await student.getByRole("button", { name: "开始本次辅导" }).click();
  await expect(student.getByRole("heading", { name: "第 1 题" })).toBeVisible({
    timeout: 15000,
  });
  await student.getByLabel("你的回答").fill("3");
  await student.getByRole("button", { name: "发送消息" }).click();
  await expect
    .poll(
      async () => {
        const r = await student.request.get(
          "http://localhost:5175/api/mistakes",
        );
        return (await r.json())[0]?.status;
      },
      { timeout: 15000 },
    )
    .toBe("pending_correction");
  await expect(student.getByRole("button", { name: "发送消息" })).toBeVisible();
  await student.getByLabel("你的回答").fill("2");
  await student.getByRole("button", { name: "发送消息" }).click();
  await expect(student.getByRole("heading", { name: "第 2 题" })).toBeVisible({
    timeout: 15000,
  });
  for (const [index, answer] of ["4", "6", "8", "10"].entries()) {
    await student.getByLabel("你的回答").fill(answer);
    await student.getByRole("button", { name: "发送消息" }).click();
    if (index < 3)
      await expect(
        student.getByRole("heading", { name: `第 ${index + 3} 题` }),
      ).toBeVisible({ timeout: 15000 });
  }
  await expect(student.getByRole("button", { name: "发送消息" })).toBeVisible({
    timeout: 15000,
  });
  await student.getByRole("button", { name: "结束本次学习" }).click();
  await expect(
    student.getByText("本次学习已保存。", { exact: false }),
  ).toBeVisible();
  await student.goto("http://localhost:5175/mistakes");
  await expect(
    student.getByRole("article").getByText("已订正，待巩固", { exact: true }),
  ).toBeVisible();
  await student.getByRole("link", { name: "查看历史与来源" }).click();
  await expect(
    student.getByRole("heading", { name: "状态与证据" }),
  ).toBeVisible();
  await student.goto(studyUrl);
  await expect(
    student.getByText("本次学习已保存。", { exact: false }),
  ).toBeVisible();
  await student.goto("http://localhost:5175/materials");
  await student
    .getByLabel("选择上传文件")
    .setInputFiles({
      name: "paper.pdf",
      mimeType: "application/pdf",
      buffer: await pdf(),
    });
  await student.getByRole("button", { name: "确认上传", exact: true }).click();
  await expect(student.getByLabel("第1题题干")).toBeVisible({ timeout: 20000 });
  await student.getByLabel("第1题题干").fill("只填最终数值：1+1=?");
  await student.getByLabel("第1题学生作答（可选）").fill("0");
  await student.getByLabel("选择第1题").check();
  await student.getByRole("button", { name: "确认所选题目" }).click();
  await expect(student.getByText("已确认 1 道题")).toBeVisible();
  const materialId = new URL(student.url()).pathname.split("/").at(-1);
  const material = await (
    await student.request.get(
      `http://localhost:5175/api/materials/${materialId}`,
    )
  ).json();
  expect(
    (
      await page.request.get(
        `http://localhost:5175/api/files/${material.fileId}/download`,
      )
    ).status(),
  ).toBe(404);
  expect(
    (
      await (
        await student.request.get("http://localhost:5175/api/mistakes")
      ).json()
    ).length,
  ).toBe(1);
  await student.goto("http://localhost:5175/profile");
  await student.getByLabel("授权账号").fill("e2e-admin");
  await student.getByRole("button", { name: "授予访问权" }).click();
  await expect(student.getByText("e2e-admin · 已授权")).toBeVisible();
  expect(
    (
      await page.request.get(
        `http://localhost:5175/api/files/${material.fileId}/download`,
      )
    ).status(),
  ).toBe(200);
  await student.getByRole("button", { name: "撤销访问" }).click();
  await expect(student.getByText("e2e-admin · 已授权")).toHaveCount(0);
  expect(
    (
      await page.request.get(
        `http://localhost:5175/api/files/${material.fileId}/download`,
      )
    ).status(),
  ).toBe(404);
  await context.close();
});
