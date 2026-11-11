import { test, expect, type Page } from "@playwright/test";
import { mockLearningApi } from "./fixtures/ui-api";

async function login(page: Page) {
  await page.getByLabel("账号", { exact: true }).fill("student");
  await page.getByLabel("密码", { exact: true }).fill("long-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

test("opens the study home right after sign-in", async ({ page }) => {
  await mockLearningApi(page);
  await page.goto("/");
  await login(page);
  await expect(
    page.getByRole("heading", { name: "选一个方向，或者直接说出来。" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "每日5练" })).toBeVisible();
  await expect(page.getByText("选择你的教材")).toHaveCount(0);
});

test("redirects the retired textbook page to the study home", async ({
  page,
}) => {
  await mockLearningApi(page);
  await page.goto("/select");
  await login(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: "选一个方向，或者直接说出来。" }),
  ).toBeVisible();
});

test("starts a learning task without binding a textbook", async ({ page }) => {
  await mockLearningApi(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route(/\/api\/tasks(\?|$)/, async (route) => {
    if (route.request().method() === "POST")
      bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fallback();
  });
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "每日5练" }).click();
  await expect(page).toHaveURL(/\/study\//);
  expect(bodies[0]).toMatchObject({ kind: "daily_practice" });
  expect(bodies[0]).not.toHaveProperty("revisionId");
});
