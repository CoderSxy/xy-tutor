import { expect, test, type Page } from "@playwright/test";

const STUDENT_A = "10000000-0000-4000-8000-00000000000a";
const STUDENT_B = "10000000-0000-4000-8000-00000000000b";
const REPORT_1 = "90000000-0000-4000-8000-000000000001";
const REPORT_2 = "90000000-0000-4000-8000-000000000002";
const TASK_A = "60000000-0000-4000-8000-00000000000a";
const FILTER = { from: "2026-10-12", to: "2026-11-10" };

const EVIDENCE = [
  {
    key: "attempt-1",
    kind: "attempt",
    id: "attempt-1",
    summary: "11 月 9 日分数练习作答",
  },
  {
    key: "attempt-2",
    kind: "attempt",
    id: "attempt-2",
    summary: "11 月 8 日分数练习作答",
  },
];

function metaFrom(url: URL) {
  return {
    from: url.searchParams.get("from") ?? FILTER.from,
    to: url.searchParams.get("to") ?? FILTER.to,
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

function reportSummary(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: REPORT_1,
    studentId: STUDENT_A,
    status: "completed",
    filter: FILTER,
    dataAsOf: "2026-11-10T03:00:00.000Z",
    generation: 1,
    attempts: 1,
    model: "faux-model",
    errorCode: null,
    evidenceCount: EVIDENCE.length,
    createdAt: "2026-11-10T03:05:00.000Z",
    completedAt: "2026-11-10T03:06:00.000Z",
    ...overrides,
  };
}

function reportContent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    summary: "本周期共完成 3 次练习，正确率保持稳定。",
    strengths: [{ text: "坚持完成每日练习。", evidenceKeys: ["attempt-1"] }],
    difficulties: [
      { text: "分数约分仍不稳定。", evidenceKeys: ["attempt-2"] },
    ],
    habits: [],
    recommendations: [
      {
        text: "每天复盘一道错题。",
        basisEvidenceKeys: ["attempt-1"],
        priority: "high",
      },
    ],
    limitations: ["样本较少，结论仅供参考。"],
    ...overrides,
  };
}

function reportDto(overrides: Record<string, unknown> = {}) {
  return {
    ...reportSummary(),
    content: reportContent(),
    evidence: EVIDENCE,
    ...overrides,
  };
}

function overviewBody(studentId: string) {
  return {
    overview: {
      studentId,
      displayName: studentId === STUDENT_A ? "李明" : "王芳",
      counts: {
        attempts: 1,
        questions: 1,
        newMistakes: 0,
        tasks: 2,
        completedTasks: 1,
        activeDays: 2,
        currentStreak: 2,
        longestStreak: 3,
        firstAttemptPending: 0,
        mistakes: {
          pending_correction: 0,
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
    meta: {
      from: FILTER.from,
      to: FILTER.to,
      timezone: "Asia/Shanghai",
      dataAsOf: "2026-11-10T03:00:00.000Z",
      metricVersion: "student-insights-v1",
      coverage: {
        learning: "partial",
        historicalInferred: false,
        visitsStartedAt: null,
        backfillVersion: null,
      },
    },
  };
}

type Reply = { status: number; body: unknown };

type MockOptions = {
  llmConfigured?: boolean;
  role?: "admin" | "student";
  historyItems?: Record<string, unknown>[];
  createReply?: (count: number) => Reply;
  reportReply?: (reportId: string, count: number) => Reply;
  retryReply?: (count: number) => Reply;
};

type AnalysisMock = {
  requests: { method: string; path: string }[];
  reportGets: (reportId: string) => number;
  writes: string[];
};

async function mockAnalysis(
  page: Page,
  options: MockOptions = {},
): Promise<AnalysisMock> {
  const requests: AnalysisMock["requests"] = [];
  const writes: string[] = [];
  const createCounts = new Map<number, number>();
  const reportCounts = new Map<string, number>();
  let retryCount = 0;

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    requests.push({ method: request.method(), path: url.pathname });
    if (request.method() !== "GET")
      writes.push(`${request.method()} ${url.pathname}`);
  });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
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
    const send = (reply: Reply) => json(reply.body, reply.status);

    if (path === "/api/auth/session")
      return json({
        actor: {
          userId: options.role === "student" ? "student-1" : "admin-1",
          role: options.role ?? "admin",
        },
      });
    if (path === "/api/students")
      return json([{ id: STUDENT_A, displayName: "管理员", permission: "owner" }]);
    if (path === "/api/capabilities")
      return json({
        llmConfigured: options.llmConfigured ?? true,
        uploadsConfigured: false,
        ocrConfigured: false,
      });
    if (path === "/api/catalog/textbooks") return json([]);

    if (!path.startsWith("/api/admin/student-insights/")) return json({});

    const student = path.match(
      /^\/api\/admin\/student-insights\/students\/([^/]+)/,
    );
    if (!student) return notFound();
    const studentId = decodeURIComponent(student[1]!);
    const rest = path.slice(student[0].length);

    if (rest === "/overview") return json(overviewBody(studentId));

    if (rest === "/reports") {
      if (method === "GET") {
        const items = options.historyItems ?? [reportSummary()];
        return json({ items, total: items.length });
      }
      const count = (createCounts.get(0) ?? 0) + 1;
      createCounts.set(0, count);
      return send(
        options.createReply?.(count) ?? {
          status: 202,
          body: { reportId: REPORT_1, status: "queued", reused: false },
        },
      );
    }

    const report = rest.match(/^\/reports\/([^/]+)(\/.*)?$/);
    if (!report) {
      const task = rest.match(/^\/tasks\/([^/]+)(\/attempts)?$/);
      if (task && method === "GET") {
        if (task[2])
          return json({
            items: [],
            total: 0,
            meta: metaFrom(url),
          });
        return json({
          task: {
            id: decodeURIComponent(task[1]!),
            kind: "practice",
            title: "分数练习",
            status: "completed",
            revisionId: "revision-1",
            chapterId: null,
            conversationId: null,
            createdAt: "2026-11-09T12:00:00.000Z",
            updatedAt: "2026-11-09T12:30:00.000Z",
            itemCount: 1,
            answeredCount: 1,
          },
          items: { items: [], total: 0, meta: metaFrom(url) },
        });
      }
      return notFound();
    }

    const reportId = decodeURIComponent(report[1]!);
    const suffix = report[2] ?? "";
    const count = (reportCounts.get(reportId) ?? 0) + 1;
    reportCounts.set(reportId, count);

    if (suffix === "/retry" && method === "POST") {
      retryCount += 1;
      return send(
        options.retryReply?.(retryCount) ?? {
          status: 200,
          body: { reportId, status: "queued", generation: 2 },
        },
      );
    }

    if (suffix === "/retry") return notFound();

    const evidence = suffix.match(/^\/evidence\/([^/]+)$/);
    if (evidence) {
      const key = decodeURIComponent(evidence[1]!);
      const detail = EVIDENCE.find((item) => item.key === key);
      if (!detail)
        return json(
          {
            error: {
              code: "NOT_FOUND",
              message: "证据已删除或失效",
            },
          },
          404,
        );
      return json({
        href: `/admin/students/${encodeURIComponent(studentId)}/records/${TASK_A}`,
        detail,
      });
    }

    if (suffix !== "" || method !== "GET") return notFound();
    return send(
      options.reportReply?.(reportId, count) ?? {
        status: 200,
        body: reportDto({ id: reportId, studentId }),
      },
    );
  });

  return {
    requests,
    writes,
    reportGets: (reportId) =>
      requests.filter(
        (request) =>
          request.method === "GET" &&
          request.path.endsWith(`/reports/${reportId}`),
      ).length,
  };
}

test("生成报告后轮询到完成，并可打开证据查看只读记录", async ({ page }) => {
  await mockAnalysis(page, {
    createReply: () => ({
      status: 202,
      body: { reportId: REPORT_1, status: "queued", reused: false },
    }),
    reportReply: (_id, count) => {
      if (count === 1)
        return {
          status: 200,
          body: reportDto({ id: REPORT_1, status: "queued", content: null }),
        };
      if (count === 2)
        return {
          status: 200,
          body: reportDto({ id: REPORT_1, status: "running", content: null }),
        };
      return { status: 200, body: reportDto({ id: REPORT_1 }) };
    },
  });

  await page.goto(`/admin/students/${STUDENT_A}/analysis`);
  await expect(
    page.getByRole("heading", { name: "生成学情报告" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "生成学情报告" }).click();

  await page.waitForURL(`**/admin/students/${STUDENT_A}/analysis/${REPORT_1}**`);
  await expect(page.getByRole("heading", { name: "学情报告" })).toBeVisible();
  await expect(page.getByText("本周期共完成 3 次练习，正确率保持稳定。")).toBeVisible();
  await expect(page.getByText("已完成", { exact: true })).toBeVisible();
  await expect(page.getByText("生成时的数据快照", { exact: false })).toBeVisible();
  await expect(page.getByText("AI 辅助分析", { exact: false })).toBeVisible();
  await expect(page.getByText("优先处理")).toBeVisible();

  await page.getByRole("button", { name: "查看证据" }).first().click();
  await page.waitForURL(`**/admin/students/${STUDENT_A}/records/${TASK_A}`);
  await expect(page.getByRole("heading", { name: "分数练习" })).toBeVisible();
});

test("重复点击生成复用同一份进行中的报告", async ({ page }) => {
  const mock = await mockAnalysis(page, {
    createReply: () => ({
      status: 200,
      body: { reportId: REPORT_1, status: "running", reused: true },
    }),
  });

  await page.goto(`/admin/students/${STUDENT_A}/analysis`);
  await page.getByRole("button", { name: "生成学情报告" }).click();
  await page.waitForURL(`**/analysis/${REPORT_1}**`);
  await expect(page.getByText("本周期共完成 3 次练习")).toBeVisible();

  await page.goto(`/admin/students/${STUDENT_A}/analysis`);
  await page.getByRole("button", { name: "生成学情报告" }).click();
  await page.waitForURL(`**/analysis/${REPORT_1}**`);

  expect(
    mock.writes.filter((write) => write.endsWith("/reports")),
  ).toHaveLength(2);
  await expect(page).not.toHaveURL(new RegExp(REPORT_2));
});

test("直接打开报告页时继续轮询直到完成", async ({ page }) => {
  await mockAnalysis(page, {
    reportReply: (_id, count) =>
      count === 1
        ? {
            status: 200,
            body: reportDto({ id: REPORT_1, status: "running", content: null }),
          }
        : { status: 200, body: reportDto({ id: REPORT_1 }) },
  });

  await page.goto(`/admin/students/${STUDENT_A}/analysis/${REPORT_1}`);
  await expect(page.getByText("生成中", { exact: true })).toBeVisible();
  await expect(page.getByText("本周期共完成 3 次练习")).toBeVisible({
    timeout: 15_000,
  });
});

test("报告历史可切换到另一份报告", async ({ page }) => {
  await mockAnalysis(page, {
    historyItems: [
      reportSummary({ id: REPORT_1, createdAt: "2026-11-10T03:05:00.000Z" }),
      reportSummary({ id: REPORT_2, createdAt: "2026-11-09T03:05:00.000Z" }),
    ],
    reportReply: (reportId) => ({
      status: 200,
      body:
        reportId === REPORT_2
          ? reportDto({
              id: REPORT_2,
              content: reportContent({ summary: "第二份报告的结论。" }),
            })
          : reportDto({ id: REPORT_1 }),
    }),
  });

  await page.goto(`/admin/students/${STUDENT_A}/analysis`);
  await expect(page.getByRole("link", { name: "查看报告" })).toHaveCount(2);
  await page.getByRole("link", { name: "查看报告" }).nth(1).click();
  await page.waitForURL(`**/analysis/${REPORT_2}**`);
  await expect(page.getByText("第二份报告的结论。")).toBeVisible();
  await expect(page.getByText("本周期共完成 3 次练习")).toHaveCount(0);
});

test("未配置模型时禁用生成并说明原因", async ({ page }) => {
  const mock = await mockAnalysis(page, { llmConfigured: false });

  await page.goto(`/admin/students/${STUDENT_A}/analysis`);
  await expect(page.getByText("未配置 AI 模型，暂时无法生成报告。")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "生成学情报告" }),
  ).toBeDisabled();
  expect(mock.writes.filter((write) => write.endsWith("/reports"))).toHaveLength(
    0,
  );
});

test("无数据、范围冲突与过于频繁时显示服务端原因", async ({ page }) => {
  const replies: Reply[] = [
    {
      status: 422,
      body: {
        error: {
          code: "VALIDATION",
          message: "暂无可分析的学习记录，请先积累学习数据",
        },
      },
    },
    {
      status: 409,
      body: {
        error: { code: "CONFLICT", message: "该学生已有正在生成的报告" },
      },
    },
    {
      status: 429,
      body: {
        error: { code: "RATE_LIMITED", message: "生成过于频繁，请稍后再试" },
      },
    },
  ];
  await mockAnalysis(page, { createReply: () => replies.shift()! });

  await page.goto(`/admin/students/${STUDENT_A}/analysis`);
  const button = page.getByRole("button", { name: "生成学情报告" });
  await button.click();
  await expect(
    page.getByRole("alert").getByText("暂无可分析的学习记录，请先积累学习数据"),
  ).toBeVisible();
  await button.click();
  await expect(
    page.getByRole("alert").getByText("该学生已有正在生成的报告"),
  ).toBeVisible();
  await button.click();
  await expect(
    page.getByRole("alert").getByText("生成过于频繁，请稍后再试"),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/analysis/);
});

test("失败报告可重试并继续轮询到完成", async ({ page }) => {
  await mockAnalysis(page, {
    reportReply: (_id, count) => {
      if (count === 1)
        return {
          status: 200,
          body: reportDto({
            id: REPORT_1,
            status: "failed",
            errorCode: "TIMEOUT",
            content: null,
          }),
        };
      if (count === 2)
        return {
          status: 200,
          body: reportDto({ id: REPORT_1, status: "queued", content: null }),
        };
      return { status: 200, body: reportDto({ id: REPORT_1 }) };
    },
  });

  await page.goto(`/admin/students/${STUDENT_A}/analysis/${REPORT_1}`);
  await expect(page.getByText("本次生成失败：生成超时")).toBeVisible();
  await page.getByRole("button", { name: "重试生成" }).click();
  await expect(page.getByText("本周期共完成 3 次练习")).toBeVisible({
    timeout: 15_000,
  });
});

test("内容引用已失效的证据时标记不可用且不提供跳转", async ({ page }) => {
  await mockAnalysis(page, {
    reportReply: () => ({
      status: 200,
      body: reportDto({
        id: REPORT_1,
        content: reportContent({
          strengths: [
            { text: "引用已删除任务的观察。", evidenceKeys: ["attempt-gone"] },
          ],
          difficulties: [],
          recommendations: [],
        }),
      }),
    }),
  });

  await page.goto(`/admin/students/${STUDENT_A}/analysis/${REPORT_1}`);
  await expect(page.getByText("引用已删除任务的观察。")).toBeVisible();
  await expect(page.getByText("证据已不可用")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "查看证据" }),
  ).toHaveCount(0);
});

test("切换到其他学生后停止轮询旧报告", async ({ page }) => {
  const mock = await mockAnalysis(page, {
    reportReply: () => ({
      status: 200,
      body: reportDto({ id: REPORT_1, status: "running", content: null }),
    }),
  });

  await page.goto(`/admin/students/${STUDENT_A}/analysis/${REPORT_1}`);
  await expect(page.getByText("生成中", { exact: true })).toBeVisible();
  const polling = mock.reportGets(REPORT_1);
  expect(polling).toBeGreaterThan(0);

  await page.goto(`/admin/students/${STUDENT_B}/analysis`);
  await expect(
    page.getByRole("heading", { name: "生成学情报告" }),
  ).toBeVisible();
  const before = mock.reportGets(REPORT_1);
  await page.waitForTimeout(4_000);
  expect(mock.reportGets(REPORT_1)).toBe(before);
});

test("学生角色看不到 AI 分析，也不请求管理端接口", async ({ page }) => {
  const mock = await mockAnalysis(page, { role: "student" });

  await page.goto(`/admin/students/${STUDENT_A}/analysis`);
  await expect(page.getByText("需要管理员权限")).toBeVisible();
  expect(
    mock.requests.filter((request) =>
      request.path.startsWith("/api/admin/student-insights/"),
    ),
  ).toHaveLength(0);
});
