import type { Page } from "@playwright/test";
export const studentId = "10000000-0000-4000-8000-000000000001";
export const revisionId = "20000000-0000-4000-8000-000000000001";
export const taskId = "30000000-0000-4000-8000-000000000001";
export const conversationId = "40000000-0000-4000-8000-000000000001";
export const runId = "60000000-0000-4000-8000-000000000001";
export const retryRunId = "60000000-0000-4000-8000-000000000002";
export async function mockLearningApi(
  page: Page,
  role: "student" | "admin" = "student",
) {
  let signedIn = false;
  let tasks: unknown[] = [];
  let selections: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const path = url.pathname;
    let status = 200;
    let body: unknown = {};
    if (path === "/api/auth/session") {
      status = signedIn ? 200 : 401;
      body = signedIn
        ? { actor: { userId: studentId, role }, studentId }
        : { error: { code: "UNAUTHENTICATED", message: "请先登录" } };
    } else if (path === "/api/auth/login") {
      signedIn = true;
      body = { actor: { userId: studentId, role }, studentId };
    } else if (path === "/api/students")
      body = [{ id: studentId, displayName: "测试同学", permission: "owner" }];
    else if (path === `/api/students/${studentId}`)
      body = {
        id: studentId,
        displayName: "测试同学",
        timezone: "Asia/Shanghai",
        preferences: {},
      };
    else if (path === "/api/capabilities")
      body = {
        llmConfigured: false,
        uploadsConfigured: false,
        ocrConfigured: false,
      };
    else if (path === "/api/catalog/textbooks")
      body = [
        {
          id: revisionId,
          title: "五年级数学",
          edition: "人教版",
          grade: "五年级",
          subject: "数学",
          term: "下册",
          publicationYear: 2024,
          status: "published",
          revisionNo: 1,
        },
      ];
    else if (path === "/api/learning/selections") {
      if (request.method() === "POST")
        selections = [
          {
            revisionId,
            grade: "五年级",
            subject: "数学",
            edition: "人教版",
            term: "下册",
            title: "五年级数学",
            publicationYear: 2024,
            revisionNo: 1,
            status: "published",
            selectedAt: new Date().toISOString(),
          },
        ];
      body = selections;
    } else if (path === "/api/tasks" && request.method() === "POST") {
      body = {
        id: taskId,
        studentId,
        revisionId,
        kind: "daily_practice",
        status: "active",
        version: 1,
        conversationId,
      };
      tasks = [body];
    } else if (path === "/api/tasks")
      body = { items: tasks, total: tasks.length };
    else if (path === `/api/tasks/${taskId}`) body = tasks[0];
    else if (path === `/api/tasks/${taskId}/items`) body = [];
    else if (path === "/api/learning/bootstrap")
      body = {
        conversationId,
        actions: [
          { id: "daily_practice", label: "每日5练" },
          { id: "knowledge_consolidation", label: "知识点巩固" },
          { id: "mistake_review", label: "错题回顾" },
          { id: "resume", label: "继续上次学习" },
          { id: "material_tutoring", label: "上传题目 / 试卷" },
          { id: "free_question", label: "自由提问" },
        ],
        fallback: "今天想从哪里开始？",
      };
    else if (path.includes("/messages")) body = [];
    else if (path.endsWith("/runs")) {
      status = 503;
      body = {
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "模型尚未配置，请联系管理员",
        },
      };
    } else if (path === "/api/review/due" || path === "/api/knowledge")
      body = [];
    else if (path.endsWith("/summary")) body = null;
    else if (/^\/api\/files\/[^/]+\/download$/.test(path))
      body = {
        url: `/test-media/${path.split("/")[3]}.png`,
        contentType: "image/png",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
    else if (
      /^\/api\/runs\/[^/]+\/retry$/.test(path) &&
      request.method() === "POST"
    )
      body = { runId: retryRunId };
    else {
      status = 404;
      body = {
        error: { code: "NOT_FOUND", message: "fixture route not implemented" },
      };
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}
