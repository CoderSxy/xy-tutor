import { test, expect, type Page } from "@playwright/test";

const adminId = "10000000-0000-4000-8000-0000000000a1";
const addSkillId = "a1000000-0000-4000-8000-000000000001";
const subSkillId = "a1000000-0000-4000-8000-000000000002";
const entryId = "b1000000-0000-4000-8000-000000000001";
const questionVersionId = "b2000000-0000-4000-8000-000000000001";
const knowledgeId = "c1000000-0000-4000-8000-000000000001";
const templateId = "d1000000-0000-4000-8000-000000000001";
const now = new Date().toISOString();

type Skill = {
  id: string;
  code: string;
  name: string;
  status: "active" | "withdrawn";
  prerequisiteIds: string[];
};

type Entry = {
  id: string;
  questionVersionId: string;
  skillId: string;
  skillName: string;
  stem: string;
  difficultyBand: "easy" | "medium" | "challenge";
  complexityBand: number;
  visibility: "shared" | "owner_only";
  ownerId: string | null;
  status:
    | "draft"
    | "checking"
    | "pending_review"
    | "published"
    | "rejected"
    | "withdrawn";
  version: number;
  sourceType: string;
  sourceRef: string | null;
  templateFamily: string | null;
  verification: string;
  publishedAt: string | null;
};

type Template = {
  id: string;
  family: string;
  skillId: string | null;
  difficultyBand: "easy" | "medium" | "challenge";
  version: number;
  status: "pending_review" | "approved" | "rejected";
  approvedAt: string | null;
};

async function mockAdminApi(page: Page) {
  const state = {
    skills: [] as Skill[],
    entries: [] as Entry[],
    templates: [
      {
        id: templateId,
        family: "fraction_add",
        skillId: null,
        difficultyBand: "easy",
        version: 1,
        status: "pending_review",
        approvedAt: null,
      },
    ] as Template[],
    links: [] as { skillId: string; knowledgeItemId: string }[],
    prerequisites: [] as { skillId: string; prerequisiteIds: string[] }[],
    createdQuestions: [] as unknown[],
    withdrawn: [] as { entryId: string; reason: string }[],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postDataJSON?.() as Record<string, unknown> | null;
    let status = 200;
    let payload: unknown = {};
    const listEntry = (entry: Entry) => entry;

    if (path === "/api/auth/session") {
      payload = { actor: { userId: adminId, role: "admin" } };
    } else if (path === "/api/auth/login") {
      payload = { actor: { userId: adminId, role: "admin" } };
    } else if (path === "/api/students") {
      payload = [];
    } else if (path === "/api/capabilities") {
      payload = { llmConfigured: false };
    } else if (path === "/api/admin/knowledge/items") {
      payload = {
        items: [{ id: knowledgeId, title: "同分母分数加法" }],
        total: 1,
      };
    } else if (path === "/api/admin/skills" && method === "POST") {
      const created: Skill = {
        id: state.skills.length === 0 ? addSkillId : subSkillId,
        code: String(body?.code ?? ""),
        name: String(body?.name ?? ""),
        status: "active",
        prerequisiteIds: [],
      };
      state.skills.push(created);
      payload = created;
    } else if (path === "/api/admin/skills") {
      payload = state.skills;
    } else if (/^\/api\/admin\/skills\/[^/]+\/content$/.test(path)) {
      state.links.push({
        skillId: path.split("/")[4] ?? "",
        knowledgeItemId: String(body?.knowledgeItemId ?? ""),
      });
      payload = {};
    } else if (/^\/api\/admin\/skills\/[^/]+\/prerequisites$/.test(path)) {
      const skillId = path.split("/")[4] ?? "";
      const prerequisiteIds = (body?.prerequisiteIds ?? []) as string[];
      state.prerequisites.push({ skillId, prerequisiteIds });
      const skill = state.skills.find((item) => item.id === skillId);
      if (skill) skill.prerequisiteIds = prerequisiteIds;
      payload = skill ?? {};
    } else if (
      path === "/api/admin/question-bank/questions" &&
      method === "POST"
    ) {
      state.createdQuestions.push(body);
      const skill = state.skills.find((item) => item.id === body?.skillId);
      const created: Entry = {
        id: entryId,
        questionVersionId,
        skillId: String(body?.skillId ?? ""),
        skillName: skill?.name ?? "",
        stem: String(body?.stem ?? ""),
        difficultyBand: (body?.difficultyBand ?? "easy") as Entry["difficultyBand"],
        complexityBand: Number(body?.complexityBand ?? 1),
        visibility: "shared",
        ownerId: null,
        status: "pending_review",
        version: 1,
        sourceType: String(body?.sourceType ?? "shared_upload"),
        sourceRef: (body?.sourceRef as string | undefined) ?? null,
        templateFamily: null,
        verification: "pending",
        publishedAt: null,
      };
      state.entries.push(created);
      payload = listEntry(created);
    } else if (path === "/api/admin/question-bank/entries") {
      payload = {
        items: state.entries.filter(
          (entry) => !url.searchParams.get("status") ||
            entry.status === url.searchParams.get("status"),
        ),
        total: state.entries.length,
      };
    } else if (
      /^\/api\/admin\/question-bank\/entries\/[^/]+\/publish$/.test(path)
    ) {
      const id = path.split("/")[5];
      const entry = state.entries.find((item) => item.id === id);
      if (!entry) {
        status = 404;
        payload = { error: { code: "NOT_FOUND", message: "题目不存在" } };
      } else if (Number(body?.version) !== entry.version) {
        status = 409;
        payload = { error: { code: "VERSION_CONFLICT", message: "题目已变更" } };
      } else {
        entry.status = "published";
        entry.publishedAt = now;
        entry.version += 1;
        payload = {};
      }
    } else if (/^\/api\/question-bank\/entries\/[^/]+\/withdraw$/.test(path)) {
      const id = path.split("/")[4] ?? "";
      const entry = state.entries.find((item) => item.id === id);
      state.withdrawn.push({ entryId: id, reason: String(body?.reason ?? "") });
      if (entry) {
        entry.status = "withdrawn";
        entry.publishedAt = null;
      }
      payload = {};
    } else if (path === "/api/admin/question-bank/templates") {
      payload = { items: state.templates };
    } else if (
      /^\/api\/admin\/question-bank\/templates\/[^/]+\/review$/.test(path)
    ) {
      const id = path.split("/")[5];
      const template = state.templates.find((item) => item.id === id);
      const decision = body?.decision;
      if (!template) {
        status = 404;
        payload = { error: { code: "NOT_FOUND", message: "模板不存在" } };
      } else if (template.status !== "pending_review") {
        status = 409;
        payload = { error: { code: "ALREADY_REVIEWED", message: "模板已审核" } };
      } else if (decision !== "approved" && decision !== "rejected") {
        status = 400;
        payload = { error: { code: "INVALID_INPUT", message: "审核结果无效" } };
      } else {
        template.status = decision;
        template.approvedAt = decision === "approved" ? now : null;
        payload = template;
      }
    } else {
      status = 404;
      payload = {
        error: { code: "NOT_FOUND", message: "fixture route not implemented" },
      };
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });
  return state;
}

test("管理员创建技能、设置前置并关联知识点", async ({ page }) => {
  const state = await mockAdminApi(page);
  await page.goto("/admin/learning-skills");
  await expect(
    page.getByRole("heading", { name: "学习技能", level: 1 }),
  ).toBeVisible();

  await page.getByLabel("技能代码").fill("fraction_add");
  await page.getByLabel("技能名称").fill("分数加法");
  await page.getByRole("button", { name: "创建技能" }).click();
  await expect(page.locator('p[role="status"]')).toHaveText("技能已创建");
  await expect(page.getByRole("heading", { name: /分数加法/ })).toBeVisible();

  await page.getByLabel("技能代码").fill("fraction_sub");
  await page.getByLabel("技能名称").fill("分数减法");
  await page.getByRole("button", { name: "创建技能" }).click();
  await expect(page.getByRole("heading", { name: /分数减法/ })).toBeVisible();

  const subtractRow = page
    .locator(".list-row")
    .filter({ hasText: "分数减法" })
    .first();
  await subtractRow.getByRole("button", { name: "编辑前置" }).click();
  await subtractRow.getByRole("checkbox", { name: "分数加法" }).check();
  await subtractRow.getByRole("button", { name: "保存前置" }).click();
  await expect(page.locator('p[role="status"]')).toHaveText("前置技能已保存");
  expect(state.prerequisites).toEqual([
    { skillId: subSkillId, prerequisiteIds: [addSkillId] },
  ]);
  await expect(subtractRow).toContainText("分数加法");

  await subtractRow.getByRole("button", { name: "关联知识点" }).click();
  await subtractRow
    .getByLabel("关联知识点")
    .selectOption({ label: "同分母分数加法" });
  await subtractRow.getByRole("button", { name: "保存关联" }).click();
  await expect(page.locator('p[role="status"]')).toHaveText("知识点已关联");
  expect(state.links).toEqual([
    { skillId: subSkillId, knowledgeItemId: knowledgeId },
  ]);
});

test("新题先待审核，发布后才生效，撤回立即停止推荐", async ({ page }) => {
  const state = await mockAdminApi(page);
  await page.goto("/admin/learning-skills");
  await page.getByLabel("技能代码").fill("fraction_add");
  await page.getByLabel("技能名称").fill("分数加法");
  await page.getByRole("button", { name: "创建技能" }).click();
  await expect(page.getByRole("heading", { name: /分数加法/ })).toBeVisible();

  await page.goto("/admin/question-bank");
  await expect(page.getByRole("heading", { name: "题库", level: 1 })).toBeVisible();
  await page.getByLabel("所属技能").selectOption({ label: "分数加法" });
  await page.getByLabel("题干").fill("计算 3/8 + 1/8");
  await page.getByLabel("参考答案").fill("1/2");
  await page.getByRole("button", { name: "提交审核" }).click();
  await expect(page.locator('p[role="status"]')).toHaveText("题目已提交审核");

  const entryRow = page.locator(".list-row").filter({ hasText: "计算 3/8 + 1/8" });
  await expect(entryRow).toContainText("待审核");
  expect(state.entries[0]?.status).toBe("pending_review");
  expect(state.entries[0]?.publishedAt).toBeNull();

  await entryRow.getByRole("button", { name: "发布" }).click();
  await expect(page.locator('p[role="status"]')).toHaveText("题目已发布");
  await expect(entryRow).toContainText("已发布");
  expect(state.entries[0]?.status).toBe("published");

  await entryRow.getByRole("button", { name: "撤回" }).click();
  await expect(entryRow.getByRole("button", { name: "确认撤回" })).toBeDisabled();
  await entryRow
    .getByLabel("撤回原因")
    .fill("答案有误，需要重新核验");
  await entryRow.getByRole("button", { name: "确认撤回" }).click();
  await expect(page.locator('p[role="status"]')).toHaveText("题目已撤回，不再进入新推荐");
  await expect(entryRow).toContainText("已撤回");
  expect(state.withdrawn).toEqual([
    { entryId, reason: "答案有误，需要重新核验" },
  ]);
  expect(state.entries[0]?.publishedAt).toBeNull();
});

test("模板审核只对 pending_review 生效", async ({ page }) => {
  await mockAdminApi(page);
  await page.goto("/admin/question-bank");
  const templateRow = page.locator(".list-row").filter({ hasText: "fraction_add" });
  await expect(templateRow).toContainText("待审核");
  await templateRow.getByRole("button", { name: "批准" }).click();
  await expect(page.locator('p[role="status"]')).toHaveText("模板已批准");
  await expect(templateRow).toContainText("已批准");
  await expect(templateRow.getByRole("button", { name: "批准" })).toHaveCount(0);
});
