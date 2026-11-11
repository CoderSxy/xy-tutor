import { expect, test, type Page } from "@playwright/test";

const STUDENT_A = "10000000-0000-4000-8000-00000000000a";
const STUDENT_B = "10000000-0000-4000-8000-00000000000b";
const TASK_A = "60000000-0000-4000-8000-00000000000a";
const TASK_A2 = "60000000-0000-4000-8000-0000000000a2";
const TASK_B = "60000000-0000-4000-8000-00000000000b";
const MISTAKE_ID = "70000000-0000-4000-8000-000000000001";
const MATERIAL_ID = "80000000-0000-4000-8000-000000000001";

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function metaFrom(url: URL, overrides: Record<string, unknown> = {}) {
  return {
    from: url.searchParams.get("from") ?? "2026-10-12",
    to: url.searchParams.get("to") ?? "2026-11-10",
    timezone: "Asia/Shanghai",
    dataAsOf: "2026-11-10T03:00:00.000Z",
    metricVersion: "student-insights-v1",
    coverage: {
      learning: "partial",
      historicalInferred: false,
      visitsStartedAt: null,
      backfillVersion: null,
    },
    ...overrides,
  };
}

function pageOf<T>(items: T[], total: number, meta: unknown) {
  return { items, total, meta };
}

type Mock = {
  requests: { method: string; path: string; search: string }[];
  writes: string[];
  failDownloadTimes: Map<string, number>;
};

async function mockRecords(page: Page): Promise<Mock> {
  const mock: Mock = {
    requests: [],
    writes: [],
    failDownloadTimes: new Map([
      ["file-image", 1],
      ["file-doc", 1],
    ]),
  };

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    mock.requests.push({
      method: request.method(),
      path: url.pathname,
      search: url.search,
    });
    if (request.method() !== "GET")
      mock.writes.push(`${request.method()} ${url.pathname}`);
  });

  await page.route("**/test-assets/pixel.png", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL_PNG }),
  );

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route
        .fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        })
        .catch(() => undefined);
    const notFound = () =>
      json({ error: { code: "NOT_FOUND", message: "未找到该记录" } }, 404);

    if (path === "/api/auth/session")
      return json({ actor: { userId: "admin-1", role: "admin" } });
    if (path === "/api/students")
      return json([
        {
          id: STUDENT_A,
          displayName: "管理员",
          permission: "owner",
        },
      ]);
    if (path === "/api/capabilities")
      return json({
        llmConfigured: false,
        uploadsConfigured: false,
        ocrConfigured: false,
      });
    if (path === "/api/catalog/textbooks") return json([]);

    if (!path.startsWith("/api/admin/student-insights/")) return json({});

    if (path === "/api/admin/student-insights/students") {
      const rows = [
        {
          studentId: STUDENT_A,
          displayName: "李明",
          studentLogins: ["liming"],
          lastLearningAt: "2026-11-09T12:30:00.000Z",
          activeDays: 5,
          attempts: 12,
          questions: 8,
          firstAttemptAccuracy: { numerator: 6, denominator: 8, value: 0.75 },
          pendingCorrections: 1,
          pendingReviews: 1,
          taskCompletion: { numerator: 3, denominator: 4, value: 0.75 },
          attentionReasons: [],
        },
        {
          studentId: STUDENT_B,
          displayName: "王芳",
          studentLogins: ["wangfang"],
          lastLearningAt: "2026-11-10T02:00:00.000Z",
          activeDays: 6,
          attempts: 6,
          questions: 5,
          firstAttemptAccuracy: { numerator: 3, denominator: 4, value: 0.75 },
          pendingCorrections: 0,
          pendingReviews: 2,
          taskCompletion: { numerator: 1, denominator: 2, value: 0.5 },
          attentionReasons: [],
        },
      ];
      return json({
        items: rows,
        total: rows.length,
        summary: { students: 2, activeStudents: 2, attempts: 18, newMistakes: 2 },
        meta: metaFrom(url),
      });
    }

    const student = path.match(
      /^\/api\/admin\/student-insights\/students\/([^/]+)/,
    );
    if (!student) return notFound();
    const studentId = decodeURIComponent(student[1]!);
    const rest = path.slice(student[0].length);
    const other = studentId !== STUDENT_A && studentId !== STUDENT_B;
    if (other) return notFound();

    if (rest === "/overview")
      return json({
        overview: {
          studentId,
          displayName: studentId === STUDENT_A ? "李明" : "王芳",
          counts: {
            attempts: 1,
            questions: 1,
            newMistakes: 1,
            tasks: 2,
            completedTasks: 1,
            activeDays: 2,
            currentStreak: 2,
            longestStreak: 3,
            firstAttemptPending: 0,
            mistakes: {
              pending_correction: 1,
              correcting: 0,
              corrected_pending_practice: 0,
              consolidated_pending_review: 0,
              mastered: 0,
            },
          },
          firstAttemptAccuracy: { numerator: 0, denominator: 0, value: null },
          taskCompletion: { numerator: 1, denominator: 2, value: 0.5 },
          daily: [],
          knowledge: [],
          materials: [],
          lastLearningAt: "2026-11-09T12:30:00.000Z",
        },
        meta: metaFrom(url),
      });

    if (rest === "/activity" && studentId === STUDENT_A)
      return json({
        days: [
          { date: "2026-11-08", events: 0, active: false, visits: 1 },
          { date: "2026-11-09", events: 3, active: true, visits: null },
          { date: "2026-11-10", events: 2, active: true, visits: 2 },
        ],
        activeDays: 2,
        currentStreak: 2,
        longestStreak: 3,
        visitedDays: 2,
        meta: metaFrom(url, {
          coverage: {
            learning: "partial",
            historicalInferred: true,
            visitsStartedAt: "2026-11-01T00:00:00.000Z",
            backfillVersion: "v1",
          },
        }),
      });

    if (rest === "/tasks") {
      const items: Record<string, unknown>[] =
        studentId === STUDENT_A
          ? [
              {
                id: TASK_A,
                kind: "daily_practice",
                title: "分数练习",
                status: "completed",
                revisionId: "rev-1",
                chapterId: null,
                conversationId: "conv-1",
                createdAt: "2026-11-09T01:00:00.000Z",
                updatedAt: "2026-11-09T02:00:00.000Z",
                itemCount: 2,
                answeredCount: 1,
              },
              {
                id: TASK_A2,
                kind: "mistake_review",
                title: "错题复习",
                status: "active",
                revisionId: "rev-1",
                chapterId: null,
                conversationId: "conv-2",
                createdAt: "2026-11-10T01:00:00.000Z",
                updatedAt: "2026-11-10T02:00:00.000Z",
                itemCount: 1,
                answeredCount: 1,
              },
            ]
          : [
              {
                id: TASK_B,
                kind: "free_question",
                title: "B 的任务",
                status: "active",
                revisionId: "rev-1",
                chapterId: null,
                conversationId: null,
                createdAt: "2026-11-10T01:00:00.000Z",
                updatedAt: "2026-11-10T02:00:00.000Z",
                itemCount: 1,
                answeredCount: 0,
              },
            ];
      return json(pageOf(items, items.length, metaFrom(url)));
    }

    const taskMatch = rest.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]!);
      const tasks: Record<
        string,
        { title: string; conversationId: string | null; answered: number }
      > = {
        [TASK_A]: {
          title: "分数练习",
          conversationId: "conv-1",
          answered: 1,
        },
        [TASK_A2]: {
          title: "错题复习",
          conversationId: "conv-2",
          answered: 1,
        },
        [TASK_B]: {
          title: "B 的任务",
          conversationId: null,
          answered: 0,
        },
      };
      const task = tasks[taskId];
      if (!task) return notFound();
      return json({
        task: {
          id: taskId,
          kind: "daily_practice",
          title: task.title,
          status: "completed",
          revisionId: "rev-1",
          chapterId: null,
          conversationId: task.conversationId,
          createdAt: "2026-11-09T01:00:00.000Z",
          updatedAt: "2026-11-09T02:00:00.000Z",
          itemCount: 2,
          answeredCount: task.answered,
        },
        items: pageOf(
          [
            {
              id: "item-1",
              questionId: "q-1",
              questionVersionId: "qv-1",
              position: 0,
              role: "practice",
              status: "answered",
              stem: "1/2 + 1/3 = ?",
              knowledgePoint: "分数加减",
            },
          ],
          1,
          metaFrom(url),
        ),
      });
    }

    const attemptsMatch = rest.match(/^\/tasks\/([^/]+)\/attempts$/);
    if (attemptsMatch)
      return json(
        pageOf(
          [
            {
              id: "attempt-1",
              taskId: decodeURIComponent(attemptsMatch[1]!),
              questionId: "q-1",
              questionVersionId: "qv-1",
              messageVersionId: null,
              answer: "5/6",
              createdAt: "2026-11-09T01:30:00.000Z",
              stem: "1/2 + 1/3 = ?",
              knowledgePoint: "分数加减",
              hints: [{ level: "hint", content: "先通分" }],
              assessment: {
                id: "assessment-1",
                correctness: "correct",
                verification: "verified",
                hintDependency: "hint",
                feedback: "通分正确，继续保持",
              },
            },
          ],
          1,
          metaFrom(url),
        ),
      );

    if (rest === "/conversations/conv-1/messages")
      return json(
        pageOf(
          [
            {
              id: "message-1",
              role: "assistant",
              versionId: "mv-1",
              versionNo: 1,
              content: "我们一起看这道分数题。",
              createdAt: "2026-11-09T01:10:00.000Z",
              attachments: [],
            },
            {
              id: "message-2",
              role: "user",
              versionId: "mv-2",
              versionNo: 1,
              content: "我算的是 **5/6**。",
              createdAt: "2026-11-09T01:20:00.000Z",
              attachments: [
                {
                  fileId: "file-image",
                  name: "作业照片",
                  contentType: "image/png",
                },
                {
                  fileId: "file-doc",
                  name: "附件说明",
                  contentType: "text/plain",
                },
              ],
            },
          ],
          2,
          metaFrom(url),
        ),
      );

    if (rest === "/conversations/conv-2/messages")
      return json(
        pageOf(
          [
            {
              id: "message-3",
              role: "user",
              versionId: "mv-3",
              versionNo: 1,
              content: "复习错题",
              createdAt: "2026-11-10T01:10:00.000Z",
              attachments: [
                {
                  fileId: "file-image-ok",
                  name: "错题照片",
                  contentType: "image/png",
                },
              ],
            },
          ],
          1,
          metaFrom(url),
        ),
      );

    const download = rest.match(/^\/files\/([^/]+)\/download$/);
    if (download) {
      const fileId = decodeURIComponent(download[1]!);
      const remaining = mock.failDownloadTimes.get(fileId) ?? 0;
      if (remaining > 0) {
        mock.failDownloadTimes.set(fileId, remaining - 1);
        return json(
          { error: { code: "NOT_FOUND", message: "附件未找到" } },
          404,
        );
      }
      const textFile = fileId === "file-doc" || fileId === "file-material";
      return json({
        url: textFile ? "/test-assets/note.txt" : "/test-assets/pixel.png",
        contentType: textFile ? "text/plain" : "image/png",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    }

    if (rest === "/mistakes") {
      const status = url.searchParams.get("status");
      const point = url.searchParams.get("knowledgePoint");
      const items = [
        {
          id: MISTAKE_ID,
          questionId: "q-1",
          status: "pending_correction",
          createdAt: "2026-11-08T01:00:00.000Z",
          dueAt: "2026-11-12T01:00:00.000Z",
          stem: "分数通分错误",
          knowledgePoint: point ?? "分数加减",
          revisionId: "rev-1",
        },
      ];
      const filtered = status
        ? items.filter((item) => item.status === status)
        : items;
      return json(pageOf(filtered, filtered.length, metaFrom(url)));
    }

    const mistakeMatch = rest.match(/^\/mistakes\/([^/]+)$/);
    if (mistakeMatch)
      return json({
        mistake: {
          id: decodeURIComponent(mistakeMatch[1]!),
          questionId: "q-1",
          status: "pending_correction",
          createdAt: "2026-11-08T01:00:00.000Z",
          dueAt: "2026-11-12T01:00:00.000Z",
          stem: "分数通分错误",
          knowledgePoint: "分数加减",
          revisionId: "rev-1",
        },
        recentEvents: [],
      });

    const eventsMatch = rest.match(/^\/mistakes\/([^/]+)\/events$/);
    if (eventsMatch) {
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const total = 21;
      const start = offset;
      const count = Math.max(0, Math.min(20, total - start));
      const items = Array.from({ length: count }, (_, index) => {
        const number = start + index + 1;
        const onSecondPage = number > 20;
        return {
          id: `event-${number}`,
          type: "transition",
          fromState: "pending_correction",
          toState: "correcting",
          reason: onSecondPage
            ? "第二页事件"
            : `第一页事件 ${number}`,
          evidenceAt: "2026-11-09T01:00:00.000Z",
          attemptId: null,
          assessmentId: null,
          createdAt: "2026-11-09T01:00:00.000Z",
        };
      });
      return json(pageOf(items, total, metaFrom(url)));
    }

    if (rest === "/materials")
      return json(
        pageOf(
          [
            {
              id: MATERIAL_ID,
              fileId: "file-material",
              name: "第三单元作业",
              contentType: "application/pdf",
              type: "exam",
              status: "published",
              revisionId: "rev-1",
              createdAt: "2026-11-07T01:00:00.000Z",
              questions: 3,
              answered: 2,
              verified: 1,
            },
          ],
          1,
          metaFrom(url),
        ),
      );

    const materialMatch = rest.match(/^\/materials\/([^/]+)$/);
    if (materialMatch)
      return json({
        material: {
          id: decodeURIComponent(materialMatch[1]!),
          fileId: "file-material",
          name: "第三单元作业",
          contentType: "application/pdf",
          type: "exam",
          status: "published",
          revisionId: "rev-1",
          createdAt: "2026-11-07T01:00:00.000Z",
          questions: 3,
          answered: 2,
          verified: 1,
        },
        extraction: {
          id: "extraction-1",
          versionNo: 1,
          model: "mock-model",
          promptVersion: "extract-v1",
          createdAt: "2026-11-07T02:00:00.000Z",
        },
      });

    const questionsMatch = rest.match(/^\/materials\/([^/]+)\/questions$/);
    if (questionsMatch)
      return json(
        pageOf(
          [
            {
              questionId: "q-1",
              questionVersionId: "qv-1",
              stem: "第一题",
              knowledgePoint: "分数加减",
              answered: true,
              verified: true,
            },
            {
              questionId: "q-1",
              questionVersionId: "qv-1b",
              stem: "第一题（新版本）",
              knowledgePoint: "分数加减",
              answered: true,
              verified: false,
            },
            {
              questionId: "q-2",
              questionVersionId: "qv-2",
              stem: "第二题",
              knowledgePoint: null,
              answered: false,
              verified: false,
            },
          ],
          3,
          metaFrom(url),
        ),
      );

    return notFound();
  });

  return mock;
}

test("任务详情展示作答、提示与核验，且不出现分值或总分", async ({ page }) => {
  await mockRecords(page);
  await page.goto(`/admin/students/${STUDENT_A}/records/${TASK_A}`);
  await expect(page.getByRole("heading", { name: "分数练习" })).toBeVisible();
  await expect(page.getByText(/已答\s*1\s*\/\s*2\s*题/)).toBeVisible();
  await expect(page.getByText("正确 · 已核验")).toBeVisible();
  await expect(page.getByText("使用提示：先通分")).toBeVisible();
  await expect(page.getByText("通分正确，继续保持")).toBeVisible();
  await expect(page.getByText("辅导员")).toBeVisible();
  await expect(page.getByText("我们一起看这道分数题。")).toBeVisible();
  await expect(page.getByText("只读")).toBeVisible();
  await expect(page.getByText("总分")).toHaveCount(0);
  await expect(page.getByText("得分")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重新生成" })).toHaveCount(0);
});

test("附件失败在局部重试，不阻塞其余对话内容", async ({ page }) => {
  await mockRecords(page);
  await page.goto(`/admin/students/${STUDENT_A}/records/${TASK_A}`);
  const image = page.locator(".insight-message").filter({ hasText: "我算的是" });
  await expect(page.getByText("我们一起看这道分数题。")).toBeVisible();
  const imageFailure = image.locator(".attachment-failure", {
    hasText: "附件未找到",
  });
  await expect(imageFailure).toBeVisible();
  await imageFailure.getByRole("button", { name: "重试" }).click();
  await expect(image.locator("img[alt='作业照片']")).toBeVisible();

  await image.getByRole("button", { name: "下载 附件说明" }).click();
  const docFailure = image.locator(".attachment-failure", {
    hasText: "附件未找到",
  });
  await expect(docFailure).toBeVisible();
  await docFailure.getByRole("button", { name: "重试" }).click();
  await expect(
    image.getByRole("link", { name: "下载 附件说明" }),
  ).toHaveAttribute("href", "/test-assets/note.txt");
});

test("错题筛选与事件分页保留条件并请求下一页", async ({ page }) => {
  const mock = await mockRecords(page);
  await page.goto(`/admin/students/${STUDENT_A}/mistakes`);
  const table = page.locator(".insight-table");
  await expect(table.getByText("待订正")).toBeVisible();
  await page.getByLabel("知识点").fill("分数");
  await page.getByRole("button", { name: "筛选" }).click();
  await expect
    .poll(() =>
      mock.requests.some(
        (request) =>
          request.path.endsWith("/mistakes") &&
          request.search.includes("knowledgePoint=%E5%88%86%E6%95%B0"),
      ),
    )
    .toBe(true);

  await page.goto(`/admin/students/${STUDENT_A}/mistakes/${MISTAKE_ID}`);
  await expect(
    page.getByText("第一页事件 1", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("第 1/2 页")).toBeVisible();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(
    page.getByText("第二页事件", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("第 2/2 页")).toBeVisible();
  await expect
    .poll(() =>
      mock.requests.some(
        (request) =>
          request.path.endsWith(`/mistakes/${MISTAKE_ID}/events`) &&
          request.search.includes("offset=20"),
      ),
    )
    .toBe(true);
});

test("作业试卷可按类型筛选，关联题按题目去重并获取原件链接", async ({
  page,
}) => {
  const mock = await mockRecords(page);
  await page.goto(`/admin/students/${STUDENT_A}/materials`);
  await expect(page.getByText("第三单元作业")).toBeVisible();
  await page.getByLabel("资料类型").selectOption("exam");
  await expect
    .poll(() =>
      mock.requests.some(
        (request) =>
          request.path.endsWith("/materials") &&
          request.search.includes("types=exam"),
      ),
    )
    .toBe(true);

  await page.getByRole("link", { name: "第三单元作业" }).click();
  await expect(page.getByRole("heading", { name: "第三单元作业" })).toBeVisible();
  await expect(page.getByText("mock-model")).toBeVisible();
  await expect(page.locator(".insight-question-list li")).toHaveCount(2);
  await expect(page.getByText("第一题（新版本）")).toHaveCount(0);

  await page.getByRole("button", { name: "获取原件下载链接" }).click();
  await expect(
    page.getByRole("link", { name: "下载原件 第三单元作业" }),
  ).toHaveAttribute("href", "/test-assets/note.txt");
});

test("活跃页把访问与学习分开，并显示覆盖说明与日历文本替代", async ({
  page,
}) => {
  await mockRecords(page);
  await page.goto(`/admin/students/${STUDENT_A}/activity`);
  await expect(
    page.getByText("历史学习数据仍在回填，覆盖不完整"),
  ).toBeVisible();
  await expect(
    page.getByText("部分历史有效学习记录由既有数据推算"),
  ).toBeVisible();
  await expect(
    page.getByText("访问仅表示打开页面，不作为学习证据"),
  ).toBeVisible();
  await expect(page.getByText("学习活跃天数")).toBeVisible();
  await expect(page.getByText("有访问记录天数")).toBeVisible();

  const day = page.locator(".insight-activity-day").first();
  await expect(day).toHaveAttribute("tabindex", "0");
  await expect(day).toHaveAttribute("aria-label", /2026-11-08/);
  await day.focus();
  await expect(day).toBeFocused();

  await expect(page.getByText("查看每日数值")).toBeVisible();
  await expect(page.locator(".insight-activity-data")).toContainText("未采集");
});

test("切换学生后不残留上一学生的任务与图片", async ({ page }) => {
  await mockRecords(page);
  await page.goto(`/admin/students/${STUDENT_A}/records`);
  await page.getByRole("link", { name: "错题复习" }).click();
  await expect(page.locator("img[alt='错题照片']")).toBeVisible();

  await page.getByRole("link", { name: /返回学生总览/ }).click();
  await page
    .locator(".insight-student", { hasText: "王芳" })
    .getByRole("link", { name: "查看学情" })
    .click();
  await page
    .getByRole("navigation", { name: "学生学情页签" })
    .getByRole("link", { name: "学习记录" })
    .click();
  await expect(page.getByRole("link", { name: "B 的任务" })).toBeVisible();
  await expect(page.getByRole("link", { name: "错题复习" })).toHaveCount(0);
  await expect(page.locator("img[alt='错题照片']")).toHaveCount(0);
});

test("移动端筛选可用且页面无横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await mockRecords(page);
  await page.goto(`/admin/students/${STUDENT_A}/mistakes`);
  await expect(page.getByLabel("错题状态")).toBeVisible();
  await expect(page.getByLabel("知识点")).toBeVisible();
  await page.getByLabel("错题状态").selectOption("pending_correction");
  await expect(
    page.locator(".insight-table").getByText("待订正"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "筛选" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);

  await page.goto(`/admin/students/${STUDENT_A}/activity`);
  await expect(page.getByRole("heading", { name: "每日学习活跃" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
});

test("浏览记录、错题、资料和活跃页面时不发送任何学生写请求", async ({
  page,
}) => {
  const mock = await mockRecords(page);
  await page.goto(`/admin/students/${STUDENT_A}/records/${TASK_A}`);
  await expect(page.getByRole("heading", { name: "分数练习" })).toBeVisible();
  await page.goto(`/admin/students/${STUDENT_A}/mistakes/${MISTAKE_ID}`);
  await expect(page.getByText("第一页事件 1", { exact: true })).toBeVisible();
  await page.goto(`/admin/students/${STUDENT_A}/materials/${MATERIAL_ID}`);
  await expect(page.getByRole("heading", { name: "第三单元作业" })).toBeVisible();
  await page.goto(`/admin/students/${STUDENT_A}/activity`);
  await expect(page.getByText("学习活跃天数")).toBeVisible();
  expect(mock.writes).toEqual([]);
});
