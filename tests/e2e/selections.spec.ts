import { test, expect } from "@playwright/test";
import { mockLearningApi } from "./fixtures/ui-api";
test("keeps the add card first and deduplicates history across reload and local storage reset", async ({
  page,
}) => {
  await mockLearningApi(page);
  await page.goto("/select");
  await page.getByLabel("账号", { exact: true }).fill("student");
  await page.getByLabel("密码", { exact: true }).fill("long-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  for (let n = 0; n < 2; n++) {
    await page
      .getByRole("button", { name: "选择年级和科目", exact: true })
      .click();
    await page.getByLabel("教材版本").selectOption("人教版");
    await page.getByLabel("年级", { exact: true }).selectOption("五年级");
    await page.getByLabel("科目", { exact: true }).selectOption("数学");
    await page.getByRole("button", { name: "进入学习空间" }).click();
    await expect(
      page.getByRole("heading", { name: "今天，从哪里开始？" }),
    ).toBeVisible();
    await page.goto("/select");
    await expect(
      page.getByRole("button", { name: "进入 五年级 数学", exact: true }),
    ).toHaveCount(1);
  }
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator(".selection-card").first()).toHaveAccessibleName(
    "选择年级和科目",
  );
  await expect(page.locator(".selection-card")).toHaveCount(2);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: `docs/qa/screenshots/selections-${width}.png`,
      fullPage: true,
    });
  }
  await page
    .getByRole("button", { name: "进入 五年级 数学", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "今天，从哪里开始？" }),
  ).toBeVisible();
});
test("keeps selection input when saving history fails", async ({ page }) => {
  await mockLearningApi(page);
  await page.route("**/api/learning/selections*", (r) =>
    r.fulfill(
      r.request().method() === "POST"
        ? { status: 503, json: { error: { message: "历史暂时无法保存" } } }
        : { json: [] },
    ),
  );
  await page.goto("/select");
  await page.getByLabel("账号", { exact: true }).fill("student");
  await page.getByLabel("密码", { exact: true }).fill("long-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page
    .getByRole("button", { name: "选择年级和科目", exact: true })
    .click();
  await page.getByLabel("教材版本").selectOption("人教版");
  await page.getByLabel("年级", { exact: true }).selectOption("五年级");
  await page.getByLabel("科目", { exact: true }).selectOption("数学");
  await page.getByRole("button", { name: "进入学习空间" }).click();
  await expect(page.getByRole("alert")).toContainText("历史暂时无法保存");
  await expect(page.getByLabel("年级", { exact: true })).toHaveValue("五年级");
  await expect(page).toHaveURL(/\/select$/);
});
test("retains disabled history even when no textbook is currently published", async ({
  page,
}) => {
  await mockLearningApi(page);
  await page.route("**/api/catalog/textbooks", (r) => r.fulfill({ json: [] }));
  let posted = false;
  await page.route("**/api/learning/selections*", (r) => {
    if (r.request().method() === "POST") posted = true;
    return r.fulfill({
      json: [
        {
          revisionId: "20000000-0000-4000-8000-000000000001",
          grade: "五年级",
          subject: "数学",
          edition: "人教版",
          term: "下册",
          title: "数学",
          publicationYear: 2024,
          revisionNo: 1,
          status: "disabled",
        },
      ],
    });
  });
  await page.goto("/select");
  await page.getByLabel("账号", { exact: true }).fill("student");
  await page.getByLabel("密码", { exact: true }).fill("long-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "进入 五年级 数学", exact: true }),
  ).toContainText("教材已停用");
  await page
    .getByRole("button", { name: "进入 五年级 数学", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("请重新选择已发布教材");
  expect(posted).toBe(false);
});
test("does not let a late history response overwrite a newly selected textbook", async ({
  page,
}) => {
  await mockLearningApi(page);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const current = {
    revisionId: "20000000-0000-4000-8000-000000000001",
    grade: "五年级",
    subject: "数学",
    edition: "人教版",
    term: "下册",
    title: "数学",
    publicationYear: 2024,
    revisionNo: 1,
    status: "published",
  };
  await page.route("**/api/learning/selections*", async (r) => {
    if (r.request().method() === "GET") {
      await gate;
      return r.fulfill({
        json: [
          {
            ...current,
            revisionId: "20000000-0000-4000-8000-000000000002",
            edition: "苏教版",
          },
        ],
      });
    }
    return r.fulfill({ json: [current] });
  });
  await page.goto("/select");
  await page.getByLabel("账号", { exact: true }).fill("student");
  await page.getByLabel("密码", { exact: true }).fill("long-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page
    .getByRole("button", { name: "选择年级和科目", exact: true })
    .click();
  await page.getByLabel("教材版本").selectOption("人教版");
  await page.getByLabel("年级", { exact: true }).selectOption("五年级");
  await page.getByLabel("科目", { exact: true }).selectOption("数学");
  await page.getByRole("button", { name: "进入学习空间" }).click();
  await expect(
    page.getByRole("heading", { name: "今天，从哪里开始？" }),
  ).toBeVisible();
  const response = page.waitForResponse(
    (r) =>
      r.url().includes("/api/learning/selections") &&
      r.request().method() === "GET",
  );
  release();
  await response;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.getByRole("link", { name: "更换教材" }).click();
  await expect(page.locator(".selection-card").nth(1)).toContainText("人教版");
});
