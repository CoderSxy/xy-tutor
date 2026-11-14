import { test, expect } from "@playwright/test";

test("continues a completed conversation and can finish again", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill("e2e-student");
  await page.getByLabel("密码", { exact: true }).fill("e2e-only-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "每日5练" })).toBeVisible();
  const response = await page.request.post("/api/tasks", {
    headers: { origin: "http://localhost:5175" },
    data: { kind: "free_question" },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const task = await response.json();
  const ended = await page.request.patch(`/api/tasks/${task.id}`, {
    headers: { origin: "http://localhost:5175" },
    data: { expectedVersion: task.version, status: "completed" },
  });
  expect(ended.ok()).toBe(true);
  await page.goto(`/study/${task.id}`);
  await expect(page.getByLabel("你的回答")).toHaveCount(0);
  await page.getByRole("button", { name: "继续学习", exact: true }).click();
  await expect(page.getByLabel("你的回答")).toBeVisible();
  await page.getByLabel("你的回答").fill("我们继续学习");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(
    page
      .getByRole("log", { name: "辅导对话" })
      .getByText("我们继续学习", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "结束本次学习" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "结束本次学习" }).click();
  await expect(
    page.getByRole("button", { name: "继续学习", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole("log", { name: "辅导对话" })
      .getByText("我们继续学习", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续学习", exact: true }).click();
  await expect(page.getByLabel("你的回答")).toBeVisible();
  const saved = await (await page.request.get(`/api/tasks/${task.id}`)).json();
  expect(saved.conversationId).toBe(task.conversationId);
  expect(saved.status).toBe("active");
});
