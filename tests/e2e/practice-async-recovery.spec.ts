import { test, expect, type Page } from "@playwright/test";
import { mockLearningApi, practiceSetId, samplePracticeItems } from "./fixtures/ui-api";

import { practiceItemSchema } from "../../packages/contracts/src/practice-sets.js";

const submissionId = "54000000-0000-4000-8000-000000000001";
async function openPractice(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockLearningApi(page, "student", { practiceSets: true });
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill("student");
  await page.getByLabel("密码", { exact: true }).fill("long-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "每日5练" }).click();
  await expect(page.getByRole("heading", { name: "第 1 题" })).toBeVisible();
}
function snapshot(state: "queued" | "complete" | "sync_failed" | "pending") {
  const items = samplePracticeItems().map(item => practiceItemSchema.parse(item));
  for (const item of items) item.progress = { ...item.progress, submission: "skipped" };
  items[0]!.progress = {
    ...items[0]!.progress,
    submission: "submitted",
    grading: state === "queued" ? "queued" : state === "pending" ? "pending" : "verified",
    correctness: state === "complete" ? "correct" : state === "sync_failed" ? "incorrect" : null,
    mistakeSync: state === "sync_failed" ? "failed" : "not_required",
    ...{ submissionId },
  };
  return { id: practiceSetId, taskId: "30000000-0000-4000-8000-000000000001", version: 1,
    mode: "step", strategy: "mixed", examProfileId: null, generation: "ready",
    submission: state === "complete" ? "completed" : state === "pending" ? "needs_review" : "grading",
    canContinue: state === "complete", items,
    counts: { total: 5, submitted: 1, skipped: 4, verified: state === "complete" || state === "sync_failed" ? 1 : 0, pending: state === "pending" ? 1 : 0 } };
}

test("polls asynchronously graded answers until next-set action appears", async ({ page }) => {
  await openPractice(page);
  let reads = 0;
  let finished = false;
  await page.route("**/api/tasks/*/practice-set**", async route => {
    reads += 1;
    await route.fulfill({ json: snapshot(finished ? "complete" : "queued") });
  });
  await page.route("**/api/practice-sets/*/submit**", async route => {
    await route.fulfill({ status: 202, json: { id: submissionId, setId: practiceSetId, state: "grading", items: snapshot("queued").items.map(i => i.progress) } });
  });
  await page.getByRole("radio", { name: "2" }).click();
  await page.getByRole("button", { name: "提交本题" }).click();
  await expect(page.getByText("批改排队中")).toBeVisible();
  // Keep grading pending beyond initial auth/load requests; completion arrives later.
  await page.waitForTimeout(3000);
  finished = true;
  await expect(page.getByRole("button", { name: "再来五题" })).toBeEnabled({ timeout: 8000 });
  expect(reads).toBeGreaterThan(1);
});

for (const state of ["sync_failed", "pending"] as const) {
  test(`recovers ${state} after reloading without an in-memory submission id`, async ({ page }) => {
    await openPractice(page);
    let retried = false;
    await page.route("**/api/tasks/*/practice-set**", async route => {
      await route.fulfill({ json: snapshot(retried ? "complete" : state) });
    });
    await page.route("**/api/practice-submissions/*/retry**", async route => {
      expect(route.request().url()).toContain(submissionId);
      retried = true;
      await route.fulfill({ json: { id: submissionId, setId: practiceSetId, state: "completed", items: snapshot("complete").items.map(i => i.progress) } });
    });
    await page.reload();
    await page.getByRole("button", { name: "重试批改 / 错题同步" }).click();
    await expect(page.getByRole("button", { name: "再来五题" })).toBeEnabled();
    expect(retried).toBe(true);
  });
}

test("confirms a published learning scope before generating an awaiting set", async ({ page }) => {
  await openPractice(page);
  let confirmed = false;
  const skillId = "61000000-0000-4000-8000-000000000001";
  await page.route("**/api/practice-skills**", route => route.fulfill({ json: [{ id: skillId, name: "有理数运算" }] }));
  await page.route("**/api/tasks/*/practice-set**", route => route.fulfill({ json: { ...snapshot("queued"), generation: confirmed ? "ready" : "awaiting_scope" } }));
  await page.route("**/api/practice-sets/*/retry-generation**", async route => {
    expect(route.request().postDataJSON().skillIds).toEqual([skillId]);
    confirmed = true;
    await route.fulfill({ json: { ...snapshot("queued"), generation: "ready" } });
  });
  await page.reload();
  await page.getByLabel("练习知识点").selectOption(skillId);
  await page.getByRole("button", { name: "确认范围并出题" }).click();
  await expect(page.getByRole("heading", { name: "第 1 题" })).toBeVisible();
  expect(confirmed).toBe(true);
});
