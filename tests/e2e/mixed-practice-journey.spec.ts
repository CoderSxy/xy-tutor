import { test, expect, type Page } from "@playwright/test";
import {
  continuedTaskId,
  mockLearningApi,
  practiceSetId,
  samplePracticeItems,
} from "./fixtures/ui-api";

async function login(page: Page) {
  await page.getByLabel("账号", { exact: true }).fill("student");
  await page.getByLabel("密码", { exact: true }).fill("long-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

test("real server keeps mixed-practice flags off by default", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill("e2e-student");
  await page.getByLabel("密码", { exact: true }).fill("e2e-only-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "选一个方向，或者直接说出来。" }),
  ).toBeVisible();
  const caps = await page.request.get("/api/capabilities");
  expect(caps.ok()).toBeTruthy();
  const body = await caps.json();
  expect(body.practiceSets).toBe("disabled");
  expect(body.mobileStudy).toBe("disabled");
});

test("mocked mixed set can switch modes, consult, skip and continue", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let canContinue = false;
  let mode = "batch";
  let version = 1;
  const items = samplePracticeItems();
  await mockLearningApi(page, "student", { practiceSets: true });
  await page.route("**/api/tasks/*/practice-set**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: {
          id: practiceSetId,
          taskId: "30000000-0000-4000-8000-000000000001",
          version,
          mode,
          strategy: "mixed",
          examProfileId: null,
          generation: "ready",
          submission: canContinue ? "completed" : "open",
          counts: {
            total: 5,
            submitted: canContinue ? 4 : 0,
            skipped: canContinue ? 1 : 0,
            verified: canContinue ? 4 : 0,
            pending: 0,
          },
          canContinue,
          items,
        },
      });
      return;
    }
    await route.fallback();
  });
  await page.route(`**/api/practice-sets/${practiceSetId}?**`, async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { mode?: string };
      mode = body.mode === "step" ? "step" : "batch";
      version += 1;
      await route.fulfill({
        json: {
          id: practiceSetId,
          taskId: "30000000-0000-4000-8000-000000000001",
          version,
          mode,
          strategy: "mixed",
          examProfileId: null,
          generation: "ready",
          submission: "open",
          counts: {
            total: 5,
            submitted: 0,
            skipped: 0,
            verified: 0,
            pending: 0,
          },
          canContinue: false,
          items,
        },
      });
      return;
    }
    await route.fallback();
  });
  await page.route(`**/api/practice-sets/${practiceSetId}/submit**`, async (route) => {
    const body = route.request().postDataJSON() as {
      skippedItemIds?: string[];
      finalize?: boolean;
    };
    if (body.finalize) {
      canContinue = true;
      for (const item of items) {
        const skipped = body.skippedItemIds?.includes(item.itemId);
        item.progress = {
          itemId: item.itemId,
          submission: skipped ? "skipped" : "submitted",
          grading: skipped ? "none" : "verified",
          correctness: skipped ? null : "correct",
          mistakeSync: "not_required",
        } as (typeof items)[number]["progress"];
      }
    }
    await route.fulfill({
      status: 202,
      json: {
        id: "54000000-0000-4000-8000-000000000001",
        setId: practiceSetId,
        state: canContinue ? "completed" : "grading",
        items: items.map((item) => item.progress),
      },
    });
  });
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "每日5练" }).click();
  await expect(page.getByRole("heading", { name: "第 1 题" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "第 5 题" })).toBeVisible();
  await page.getByRole("button", { name: "逐题作答" }).click();
  await expect(page.getByRole("button", { name: "逐题作答" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "整组作答" }).click();
  await page.getByRole("radio", { name: "2" }).click();
  await page.getByRole("radio", { name: "4" }).click();
  await page.getByPlaceholder("填写答案").nth(0).fill("6");
  await page.getByPlaceholder("填写答案").nth(1).fill("8");
  await page.getByLabel("作答意图").selectOption("question");
  await page.getByLabel("你的回答").fill("先问一下这组题的目标。");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByText("模型尚未配置").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "再来五题" })).toHaveCount(0);
  await page.getByRole("button", { name: "提交本组" }).click();
  await expect(page.getByRole("dialog", { name: "还有未作答的题目" })).toBeVisible();
  await page.getByRole("button", { name: "确认跳过并交卷" }).click();
  await expect(page.getByRole("button", { name: "再来五题" })).toBeEnabled();
  await page.getByRole("button", { name: "再来五题" }).click();
  await expect(page).toHaveURL(new RegExp(`/study/${continuedTaskId}`));
});
