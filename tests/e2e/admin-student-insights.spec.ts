import { expect, test, type Page } from "@playwright/test";

const STUDENT_A = "10000000-0000-4000-8000-00000000000a";
const STUDENT_B = "10000000-0000-4000-8000-00000000000b";
const STUDENT_EMPTY = "10000000-0000-4000-8000-00000000000c";
const STUDENT_MISSING = "10000000-0000-4000-8000-0000000000ff";
const REVISION_ID = "20000000-0000-4000-8000-000000000001";

function shanghaiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(day: string, amount: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(
    Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + amount),
  )
    .toISOString()
    .slice(0, 10);
}

type Row = {
  studentId: string;
  displayName: string;
  studentLogins: string[];
  lastLearningAt: string | null;
  activeDays: number;
  attempts: number;
  questions: number;
  firstAttemptAccuracy: {
    numerator: number;
    denominator: number;
    value: number | null;
  };
  pendingCorrections: number;
  pendingReviews: number;
  taskCompletion: {
    numerator: number;
    denominator: number;
    value: number | null;
  };
  attentionReasons: {
    type: "inactive_7d" | "pending_corrections_10";
    label: string;
    value: number;
  }[];
};

function rowA(): Row {
  return {
    studentId: STUDENT_A,
    displayName: "李明",
    studentLogins: ["liming"],
    lastLearningAt: "2026-11-09T12:30:00.000Z",
    activeDays: 5,
    attempts: 12,
    questions: 8,
    firstAttemptAccuracy: { numerator: 6, denominator: 8, value: 0.75 },
    pendingCorrections: 3,
    pendingReviews: 1,
    taskCompletion: { numerator: 3, denominator: 4, value: 0.75 },
    attentionReasons: [
      { type: "inactive_7d", label: "近 7 天未学习", value: 8 },
    ],
  };
}

function rowB(): Row {
  return {
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
  };
}

function rowEmpty(): Row {
  return {
    studentId: STUDENT_EMPTY,
    displayName: "安静",
    studentLogins: ["anjing"],
    lastLearningAt: null,
    activeDays: 0,
    attempts: 0,
    questions: 0,
    firstAttemptAccuracy: { numerator: 0, denominator: 0, value: null },
    pendingCorrections: 0,
    pendingReviews: 0,
    taskCompletion: { numerator: 0, denominator: 0, value: null },
    attentionReasons: [],
  };
}

function metaFrom(url: URL) {
  return {
    from: url.searchParams.get("from") ?? addDays(shanghaiToday(), -29),
    to: url.searchParams.get("to") ?? shanghaiToday(),
    timezone: "Asia/Shanghai",
    dataAsOf: "2026-11-10T03:00:00.000Z",
    metricVersion: "student-insights-v1",
    coverage: {
      learning: "partial",
      historicalInferred: false,
      visitsStartedAt: null,
      backfillVersion: null,
    },
  };
}

function overviewFor(row: Row) {
  const empty = row.attempts === 0;
  return {
    studentId: row.studentId,
    displayName: row.displayName,
    counts: {
      attempts: row.attempts,
      questions: row.questions,
      newMistakes: empty ? 0 : 2,
      tasks: empty ? 0 : 4,
      completedTasks: empty ? 0 : 3,
      activeDays: row.activeDays,
      currentStreak: empty ? 0 : 2,
      longestStreak: empty ? 0 : 3,
      firstAttemptPending: empty ? 0 : 1,
      mistakes: {
        pending_correction: empty ? 0 : 3,
        correcting: 0,
        corrected_pending_practice: empty ? 0 : 1,
        consolidated_pending_review: empty ? 0 : 1,
        mastered: empty ? 0 : 2,
      },
    },
    firstAttemptAccuracy: row.firstAttemptAccuracy,
    taskCompletion: row.taskCompletion,
    daily: empty
      ? []
      : [
          {
            date: "2026-11-08",
            attempts: 3,
            questions: 2,
            firstAttempts: { numerator: 1, denominator: 2, value: 0.5 },
          },
          {
            date: "2026-11-09",
            attempts: 5,
            questions: 3,
            firstAttempts: { numerator: 3, denominator: 5, value: 0.6 },
          },
          {
            date: "2026-11-10",
            attempts: 4,
            questions: 3,
            firstAttempts: { numerator: 2, denominator: 3, value: 0.667 },
          },
        ],
    knowledge: empty
      ? []
      : [
          {
            knowledgePoint: "分数加减",
            attempts: 6,
            verified: 4,
            correct: 3,
            hintDependency: { none: 2, hint: 1, answer: 1 },
          },
        ],
    materials: empty
      ? []
      : [
          {
            materialId: "50000000-0000-4000-8000-000000000001",
            name: "第三单元作业",
            type: "homework",
            status: "published",
            totalQuestions: 10,
            answeredQuestions: 8,
            verifiedQuestions: 6,
          },
        ],
    lastLearningAt: row.lastLearningAt,
  };
}

async function mockInsights(
  page: Page,
  role: "student" | "admin" = "admin",
) {
  const adminRequests: string[] = [];
  let listFailures = 0;
  let listDelay = 0;
  let overviewDelay = 0;
  const rows = [rowA(), rowB(), rowEmpty()];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route
        .fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        })
        .catch(() => undefined);
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    if (path === "/api/auth/session")
      return json({
        actor: { userId: "admin-1", role },
        ...(role === "student" ? { studentId: STUDENT_A } : {}),
      });
    if (path === "/api/students")
      return json([
        {
          id: STUDENT_A,
          displayName: role === "admin" ? "管理员" : "李明",
          permission: "owner",
        },
      ]);
    if (path === "/api/capabilities")
      return json({
        llmConfigured: false,
        uploadsConfigured: false,
        ocrConfigured: false,
      });
    if (path === "/api/catalog/textbooks")
      return json([
        {
          id: REVISION_ID,
          textbookId: "30000000-0000-4000-8000-000000000001",
          fileId: "40000000-0000-4000-8000-000000000001",
          revisionNo: 1,
          status: "published",
          pageCount: 120,
          title: "五年级数学",
          edition: "人教版",
          grade: "五年级",
          subject: "数学",
          term: "下册",
          publicationYear: 2024,
        },
      ]);

    if (path.startsWith("/api/admin/student-insights/")) {
      adminRequests.push(`${path}${url.search}`);
      if (path === "/api/admin/student-insights/students") {
        if (listFailures > 0) {
          listFailures -= 1;
          return json(
            { error: { code: "INTERNAL", message: "服务暂时不可用" } },
            500,
          );
        }
        if (listDelay) await sleep(listDelay);
        const q = url.searchParams.get("q");
        const items = rows.filter(
          (row) =>
            !q ||
            row.displayName.includes(q) ||
            row.studentLogins.some((login) => login.includes(q)),
        );
        return json({
          items,
          total: items.length,
          summary: {
            students: 3,
            activeStudents: 2,
            attempts: 18,
            newMistakes: 4,
          },
          meta: metaFrom(url),
        });
      }
      const overview = path.match(
        /^\/api\/admin\/student-insights\/students\/([^/]+)\/overview$/,
      );
      if (overview) {
        const row = rows.find(
          (item) => item.studentId === decodeURIComponent(overview[1]!),
        );
        if (!row)
          return json(
            { error: { code: "NOT_FOUND", message: "未找到该学生" } },
            404,
          );
        if (overviewDelay) await sleep(overviewDelay);
        return json({ overview: overviewFor(row), meta: metaFrom(url) });
      }
      return json(
        { error: { code: "NOT_FOUND", message: "未找到" } },
        404,
      );
    }
    return json({});
  });
  return {
    adminRequests,
    failNextList() {
      listFailures = 1;
    },
    delayList(ms: number) {
      listDelay = ms;
    },
    delayOverview(ms: number) {
      overviewDelay = ms;
    },
  };
}

test("学生角色没有学生学情入口，直接访问也不请求管理员接口", async ({
  page,
}) => {
  const mock = await mockInsights(page, "student");
  await page.goto("/admin/students");
  await expect(page.getByText("需要管理员权限")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "学生学情" }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "学生学情" })).toHaveCount(0);
  expect(mock.adminRequests).toEqual([]);
});

test("管理员列表包含空学生，筛选写入 URL，返回时保留条件", async ({
  page,
}) => {
  await mockInsights(page, "admin");
  await page.goto("/admin/students");
  await expect(
    page.getByRole("heading", { name: "学生学情", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "学生学情" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.locator(".insight-summary dd").allTextContents(),
    )
    .toEqual(["3", "2", "18", "4"]);
  const empty = page.locator(".insight-student", { hasText: "安静" });
  await expect(empty.getByText("暂无学习记录")).toBeVisible();

  await page.getByRole("button", { name: "近7天" }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("from"))
    .toBe(addDays(shanghaiToday(), -6));
  await expect
    .poll(() => new URL(page.url()).searchParams.get("to"))
    .toBe(shanghaiToday());

  await page.getByLabel("搜索学生").fill("李");
  await page.getByRole("button", { name: "搜索" }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("q"))
    .toBe("李");
  const row = page.locator(".insight-student", { hasText: "李明" });
  await row.getByRole("link", { name: "查看学情" }).click();
  await expect(page.getByRole("heading", { name: "李明" })).toBeVisible();
  await expect(page.getByText("75%").first()).toBeVisible();

  await page.getByRole("link", { name: /返回学生总览/ }).click();
  await expect(page).toHaveURL(/q=%E6%9D%8E/);
  await expect(page.getByLabel("搜索学生")).toHaveValue("李");
  await expect(
    page.locator(".insight-student", { hasText: "李明" }),
  ).toBeVisible();
});

test("概览显示趋势数值和图表文本替代", async ({ page }) => {
  await mockInsights(page, "admin");
  await page.goto(`/admin/students/${STUDENT_A}/overview`);
  await expect(page.getByRole("heading", { name: "李明" })).toBeVisible();
  const chart = page.locator(".insight-trend-svg");
  await expect(chart).toBeVisible();
  await expect(chart.locator("text").filter({ hasText: "%" })).not.toHaveCount(
    0,
  );
  await expect(page.getByText("首次正确率 67%", { exact: true })).toBeVisible();
  await expect(page.getByText("查看每日数值")).toBeVisible();
  await expect(page.getByText("分数加减")).toBeVisible();
  await expect(page.getByText("第三单元作业")).toBeVisible();
});

test("空学生详情显示暂无记录与无可核验样本", async ({ page }) => {
  await mockInsights(page, "admin");
  await page.goto(`/admin/students/${STUDENT_EMPTY}/overview`);
  await expect(page.getByRole("heading", { name: "安静" })).toBeVisible();
  await expect(page.getByText("暂无学习记录").first()).toBeVisible();
  await expect(page.getByText("暂无可核验样本").first()).toBeVisible();
  await expect(page.locator(".insight-trend-svg")).toHaveCount(0);
});

test("列表加载、失败原位置重试和详情 404", async ({ page }) => {
  const mock = await mockInsights(page, "admin");
  mock.delayList(500);
  await page.goto("/admin/students");
  await expect(page.getByText("正在读取学生学情")).toBeVisible();
  await expect(
    page.locator(".insight-student", { hasText: "李明" }),
  ).toBeVisible();

  mock.failNextList();
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("服务暂时不可用");
  await page.getByRole("button", { name: "重试" }).click();
  await expect(
    page.locator(".insight-student", { hasText: "李明" }),
  ).toBeVisible();

  await page.goto(`/admin/students/${STUDENT_MISSING}/overview`);
  await expect(page.getByText("404 · 未找到该学生或记录")).toBeVisible();
});

test("从 A 快速切换到 B 时迟到的 A 响应不会覆盖 B", async ({ page }) => {
  const mock = await mockInsights(page, "admin");
  mock.delayOverview(800);
  await page.goto("/admin/students");
  await page
    .locator(".insight-student", { hasText: "李明" })
    .getByRole("link", { name: "查看学情" })
    .click();
  await expect(page.getByRole("link", { name: /返回学生总览/ })).toBeVisible();
  await page.getByRole("link", { name: /返回学生总览/ }).click();
  await page
    .locator(".insight-student", { hasText: "王芳" })
    .getByRole("link", { name: "查看学情" })
    .click();
  await expect(page.getByRole("heading", { name: "王芳" })).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(page.getByRole("heading", { name: "王芳" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "李明" })).toHaveCount(0);
});

for (const width of [360, 768, 1280]) {
  test(`学情列表和概览在 ${width}px 无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockInsights(page, "admin");
    await page.goto("/admin/students");
    await expect(
      page.getByRole("heading", { name: "学生学情", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: `docs/qa/screenshots/admin-students-${width}.png`,
      fullPage: true,
    });
    await page.goto(`/admin/students/${STUDENT_A}/overview`);
    await expect(page.getByRole("heading", { name: "李明" })).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "学生学情页签" })
        .getByRole("link", { name: "学习记录" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: `docs/qa/screenshots/admin-student-overview-${width}.png`,
      fullPage: true,
    });
  });
}
