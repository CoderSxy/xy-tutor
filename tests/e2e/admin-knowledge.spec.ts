import { test, expect, type Page } from "@playwright/test";
import { mockLearningApi } from "./fixtures/ui-api";

const batchId = "80000000-0000-4000-8000-000000000001";
const runId = "81000000-0000-4000-8000-000000000001";
const itemId = "82000000-0000-4000-8000-000000000001";
const now = new Date().toISOString();

type MockItem = {
  id: string;
  batchId: string;
  parseRunId: string;
  title: string;
  summary: string;
  status: "pending_review" | "published" | "discarded";
  replacesItemId: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

async function login(page: Page) {
  await page.getByLabel("账号", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("long-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

async function mockKnowledgeApi(
  page: Page,
  initial: { items?: MockItem[]; runStatus?: string; errorCode?: string } = {},
) {
  const state = {
    created: false,
    items: initial.items ?? ([] as MockItem[]),
    patchBody: undefined as unknown,
    reparseBody: undefined as unknown,
  };
  const run = () => ({
    id: runId,
    batchId,
    extraPrompt: null,
    model: null,
    status: initial.runStatus ?? "succeeded",
    errorCode: initial.errorCode ?? null,
    itemCount: state.items.length,
    createdAt: now,
    completedAt: now,
  });
  const batch = () => ({
    id: batchId,
    textContent: "同分母分数相加减，分母不变，分子相加减。",
    files: [],
    latestRun: run(),
    pendingCount: state.items.filter((i) => i.status === "pending_review").length,
    publishedCount: state.items.filter((i) => i.status === "published").length,
    createdAt: now,
  });
  await page.route("**/api/admin/knowledge/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    let body: unknown = {};
    if (path === "/api/admin/knowledge/batches" && method === "POST") {
      state.created = true;
      state.items = [
        {
          id: itemId,
          batchId,
          parseRunId: runId,
          title: "分数加减法",
          summary: "同分母分数相加减。",
          status: "pending_review",
          replacesItemId: null,
          publishedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ];
      body = batch();
    } else if (path === "/api/admin/knowledge/batches") {
      body = { items: state.created ? [batch()] : [], total: state.created ? 1 : 0 };
    } else if (path === `/api/admin/knowledge/batches/${batchId}`) {
      body = batch();
    } else if (path.endsWith("/reparse")) {
      state.reparseBody = request.postDataJSON();
      body = { ...run(), status: "queued", errorCode: null, completedAt: null };
    } else if (path === "/api/admin/knowledge/items") {
      const status = new URL(request.url()).searchParams.get("status");
      const q = new URL(request.url()).searchParams.get("q");
      const items = state.items.filter(
        (item) =>
          (!status || item.status === status) &&
          (!q || item.title.includes(q) || item.summary.includes(q)),
      );
      body = { items, total: items.length };
    } else if (path.endsWith("/publish")) {
      const ids = (request.postDataJSON() as { ids: string[] }).ids;
      state.items = state.items.map((item) =>
        ids.includes(item.id)
          ? { ...item, status: "published", publishedAt: now }
          : item,
      );
      body = state.items.filter((item) => ids.includes(item.id));
    } else if (path.endsWith("/discard")) {
      const ids = (request.postDataJSON() as { ids: string[] }).ids;
      state.items = state.items.map((item) =>
        ids.includes(item.id) ? { ...item, status: "discarded" } : item,
      );
      body = {};
    } else if (method === "PATCH") {
      state.patchBody = request.postDataJSON();
      const patch = state.patchBody as { title: string; summary: string };
      state.items = state.items.map((item) =>
        item.id === itemId ? { ...item, ...patch } : item,
      );
      body = state.items.find((item) => item.id === itemId);
    }
    await route.fulfill({ json: body });
  });
  return state;
}

test("redirects the retired textbook admin page to the knowledge base", async ({
  page,
}) => {
  await mockLearningApi(page, "admin");
  await mockKnowledgeApi(page);
  await page.goto("/admin/textbooks");
  await login(page);
  await expect(page).toHaveURL(/\/admin\/knowledge$/);
  await expect(
    page.getByRole("heading", { name: "知识点", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "知识点" })).toBeVisible();
});

test("uploads source text, reviews pending items and publishes them", async ({
  page,
}) => {
  await mockLearningApi(page, "admin");
  const state = await mockKnowledgeApi(page);
  await page.goto("/admin/knowledge");
  await login(page);
  await page.getByRole("button", { name: "上传知识点资料" }).click();
  await page.getByLabel("粘贴知识点内容").fill("同分母分数相加减，分母不变，分子相加减。");
  await page.getByRole("button", { name: "解析为知识点" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/knowledge/${batchId}$`));
  await expect(
    page.getByRole("heading", { name: "检查知识点", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("标题")).toHaveValue("分数加减法");
  await page.getByLabel("标题").fill("同分母分数加减法");
  await page.getByLabel("总结").fill("分母不变，分子相加减。");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("知识点已保存")).toBeVisible();
  expect(state.patchBody).toMatchObject({
    title: "同分母分数加减法",
    summary: "分母不变，分子相加减。",
  });
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "确认发布所选" }).click();
  await expect(page.getByText("已发布 1 个知识点")).toBeVisible();
  await page.getByRole("link", { name: "返回知识点列表" }).click();
  await expect(page).toHaveURL(/\/admin\/knowledge$/);
  await expect(page.getByText("同分母分数加减法")).toBeVisible();
});

test("filters published items, edits them and requests a reparse", async ({
  page,
}) => {
  await mockLearningApi(page, "admin");
  const state = await mockKnowledgeApi(page, {
    items: [
      {
        id: itemId,
        batchId,
        parseRunId: runId,
        title: "异分母分数加减法",
        summary: "先通分再计算。",
        status: "published",
        replacesItemId: null,
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
  await page.goto("/admin/knowledge");
  await login(page);
  await page.getByLabel("状态").selectOption("published");
  await expect(page.getByText("异分母分数加减法")).toBeVisible();
  await page.getByRole("button", { name: "编辑" }).click();
  await page.getByLabel("总结").fill("先通分，再按同分母计算。");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("知识点已保存")).toBeVisible();
  expect(state.patchBody).toMatchObject({ summary: "先通分，再按同分母计算。" });
  await page.getByRole("button", { name: "再解析" }).click();
  await page.getByLabel("补充解析要求").fill("把通分步骤拆得更细。");
  await page.getByRole("button", { name: "提交再解析" }).click();
  await expect(
    page.getByText("已提交再解析，重新解析完成前保留已发布内容。"),
  ).toBeVisible();
  expect(state.reparseBody).toMatchObject({ extraPrompt: "把通分步骤拆得更细。" });
});

test("explains why a knowledge parse run failed", async ({ page }) => {
  await mockLearningApi(page, "admin");
  await mockKnowledgeApi(page, {
    runStatus: "failed",
    errorCode: "INVALID_KNOWLEDGE_SOURCE",
  });
  await page.goto(`/admin/knowledge/${batchId}`);
  await login(page);
  await expect(
    page.getByText("资料文件尚未就绪或无法读取，请重新上传后解析。"),
  ).toBeVisible();
});
