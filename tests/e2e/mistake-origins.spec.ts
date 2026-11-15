import { test, expect, type Page } from "@playwright/test";
import { mockLearningApi, studentId } from "./fixtures/ui-api";

const PAGE_SIZE = 20;

function mistake(index: number, origin: "uploaded" | "learning" | "unknown") {
  const id = `71000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    id,
    questionId: `72000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    questionVersionId: `73000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    stem: `错题 ${origin} #${index}`,
    status: "pending_correction",
    dueAt: null,
    version: 1,
    originalAttemptId: null,
    hasImageEvidence: origin === "uploaded",
    originCategory: origin,
    originDetail:
      origin === "uploaded"
        ? "material_import"
        : origin === "learning"
          ? "daily_practice"
          : "unknown",
    lifecycle: "active",
    originTaskId:
      origin === "learning" ? "30000000-0000-4000-8000-000000000001" : null,
    originConversationId:
      origin === "learning" ? "40000000-0000-4000-8000-000000000001" : null,
    originMessageVersionId: null,
    originQuestionVersionId: null,
  };
}

function catalog() {
  return [
    ...Array.from({ length: 10 }, (_, i) => mistake(i + 101, "unknown")),
    ...Array.from({ length: 40 }, (_, i) => mistake(i + 1, "uploaded")),
    ...Array.from({ length: 60 }, (_, i) => mistake(i + 41, "learning")),
  ];
}

async function mockPagedMistakes(page: Page) {
  const items = catalog();
  await page.route("**/api/mistakes**", async (route) => {
    const url = new URL(route.request().url());
    const detail = url.pathname.match(/^\/api\/mistakes\/([^/]+)(\/history)?$/);
    if (detail) {
      if (detail[2] === "/history") {
        await route.fulfill({ json: [] });
        return;
      }
      const found = items.find((item) => item.id === detail[1]);
      await route.fulfill({
        status: found ? 200 : 404,
        json: found ?? { error: { message: "错题不存在" } },
      });
      return;
    }
    if (!url.pathname.endsWith("/api/mistakes")) {
      await route.fallback();
      return;
    }
    const origin = url.searchParams.get("origin");
    const pageNo = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? PAGE_SIZE);
    const filtered = origin
      ? items.filter((item) => item.originCategory === origin)
      : items;
    const start = (pageNo - 1) * pageSize;
    await route.fulfill({
      json: {
        items: filtered.slice(start, start + pageSize),
        total: filtered.length,
        page: pageNo,
        pageSize,
        originCounts: {
          all: items.length,
          uploaded: 40,
          learning: 60,
          unknown: 10,
        },
      },
    });
  });
}

async function login(page: Page) {
  await mockLearningApi(page);
  await mockPagedMistakes(page);
  await page.goto("/mistakes");
  await page.getByLabel("账号", { exact: true }).fill("student");
  await page.getByLabel("密码", { exact: true }).fill("long-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

test("paginates mixed origins and keeps unknown only in the all tab", async ({
  page,
}) => {
  await login(page);
  await expect(page.getByRole("tab", { name: /全部/ })).toContainText("110");
  await expect(page.getByRole("tab", { name: /学习错题/ })).toContainText("60");
  await expect(page.getByText("来源待确认").first()).toBeVisible();
  await page.getByRole("tab", { name: /学习错题/ }).click();
  await expect(page).toHaveURL(/origin=learning/);
  await expect(page.getByText("来源待确认")).toHaveCount(0);
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page).toHaveURL(/page=2/);
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByText("错题 learning #81")).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/origin=learning/);
  await expect(page.getByText("错题 learning #81")).toBeVisible();
});

test("opens a learning-origin detail from the list", async ({ page }) => {
  await login(page);
  await page.getByRole("tab", { name: /学习错题/ }).click();
  await page.getByRole("link", { name: "查看历史与来源" }).first().click();
  await expect(page.getByRole("heading", { name: "错题详情" })).toBeVisible();
});
