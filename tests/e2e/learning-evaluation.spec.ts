import { expect, test, type Page, type Request } from "@playwright/test";
import {
  conversationId,
  studentId,
  taskId,
} from "./fixtures/ui-api";

const questionVersionId = "50000000-0000-4000-8000-000000000001";
const episodeId = "70000000-0000-4000-8000-000000000001";
const recordTaskId = "60000000-0000-4000-8000-00000000000a";
const attemptId = "a0000000-0000-4000-8000-000000000001";
const diagnosisId = "d0000000-0000-4000-8000-000000000001";
const FILTER = { from: "2026-10-12", to: "2026-11-10" };
const reviewReason = "步骤里能看到进位漏掉了，属于规则用错。";

const task = {
  id: taskId,
  studentId,
  revisionId: "20000000-0000-4000-8000-000000000001",
  kind: "daily_practice",
  status: "active",
  version: 1,
  conversationId,
};

const item = {
  id: "80000000-0000-4000-8000-000000000001",
  questionVersionId,
  position: 1,
  role: "independent",
  status: "pending",
  stem: "3/4 + 1/8 等于多少？",
  knowledgePoint: "分数加法",
};

type Flags = {
  timing?: boolean;
  selfCheck?: boolean;
  adaptivePractice?: boolean;
  learningEvaluation?: boolean;
};

const emptyRatio = { numerator: 0, denominator: 0, value: null };

const emptyMetrics = {
  confirmedDiagnosis: {
    overall: emptyRatio,
    byCode: {},
    byQuestionType: {},
    bySource: {},
    byRuleVersion: {},
  },
  diagnosisCoverage: emptyRatio,
  diagnosisGaps: { unsupported: 0, insufficient: 0 },
  selfCheckSuccess: { overall: emptyRatio, byAnchor: {}, byHintLevel: {} },
  independentNewCorrect: emptyRatio,
  independentCoverage: emptyRatio,
  hintDependency: {},
  delayedReview: { completion: emptyRatio, pass: emptyRatio },
  timing: { coverage: emptyRatio, reliable: emptyRatio, reasons: {} },
  efficiency: [] as Record<string, unknown>[],
  questionQuality: emptyRatio,
};

function evaluationBody(overrides: Record<string, unknown> = {}) {
  return {
    studentId,
    from: FILTER.from,
    to: FILTER.to,
    metrics: emptyMetrics,
    sampleSize: 0,
    baselines: [],
    groupReference: {
      enabled: false,
      available: false,
      studentCount: 0,
      sampleCount: 0,
      maxSamplesPerStudent: 5,
      reasonCodes: [],
    },
    versions: { metric: "learning-evaluation-v1", policy: "adaptive-v1" },
    dataAsOf: "2026-11-10T03:00:00.000Z",
    generatedAt: "2026-11-10T03:05:00.000Z",
    staleEvidenceCount: 0,
    ...overrides,
  };
}

function overviewBody() {
  return {
    overview: {
      studentId,
      displayName: "李明",
      counts: {
        attempts: 1,
        questions: 1,
        newMistakes: 0,
        tasks: 1,
        completedTasks: 1,
        activeDays: 1,
        currentStreak: 1,
        longestStreak: 1,
        firstAttemptPending: 0,
        mistakes: {
          pending_correction: 0,
          correcting: 0,
          corrected_pending_practice: 0,
          consolidated_pending_review: 0,
          mastered: 0,
        },
      },
      firstAttemptAccuracy: { numerator: 1, denominator: 1, value: 1 },
      taskCompletion: { numerator: 1, denominator: 1, value: 1 },
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

function profileBody() {
  return [
    {
      studentId,
      skillId: "90000000-0000-4000-8000-000000000001",
      version: 3,
      stale: false,
      trainingBand: "consolidation",
      recentIndependentCorrect: 3,
      recentDeterminateCount: 5,
      efficiency: {
        status: "observed",
        baselineId: "80000000-0000-4000-8000-000000000001",
        sampleCount: 6,
        medianMs: 92_000,
        timeRatio: 1.4,
        direction: "slower",
        reasonCodes: [],
      },
      habits: [
        {
          anchorCode: "write_key_steps",
          independentCheckCount: 2,
          successfulCorrectionCount: 1,
        },
      ],
      evidence: [],
    },
  ];
}

function attemptBody(diagnosis: Record<string, unknown> | null) {
  return {
    id: attemptId,
    taskId: recordTaskId,
    questionId: "10000000-0000-4000-8000-000000000001",
    questionVersionId,
    messageVersionId: null,
    answer: "7/16",
    createdAt: "2026-11-09T12:20:00.000Z",
    stem: "3/4 + 1/8 等于多少？",
    knowledgePoint: "分数加法",
    hints: [],
    assessment: {
      id: "a1000000-0000-4000-8000-000000000001",
      correctness: "incorrect",
      verification: "verified",
      hintDependency: "none",
      feedback: null,
    },
    diagnosis,
  };
}

type MockOptions = Flags & { role?: "student" | "admin" };

async function mockAdaptiveLearningApi(page: Page, options: MockOptions = {}) {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const enabled = (value: boolean | undefined) =>
    value === false ? "disabled" : "enabled";
  let diagnosisVersion = 1;
  let reviews: Record<string, unknown>[] = [];

  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    let body: unknown = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = request.postData();
    }
    requests.push({ method: request.method(), path: url.pathname, body });
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });

    if (path === "/api/auth/session")
      return json({
        actor: { userId: options.role ?? "student", role: options.role ?? "student" },
        studentId,
      });
    if (path === "/api/students")
      return json([{ id: studentId, displayName: "李明", permission: "owner" }]);
    if (path === `/api/students/${studentId}`)
      return json({
        id: studentId,
        displayName: "李明",
        timezone: "Asia/Shanghai",
        preferences: {},
      });
    if (path === `/api/students/${studentId}/access`) return json([]);
    if (path === "/api/capabilities")
      return json({
        llmConfigured: false,
        uploadsConfigured: false,
        ocrConfigured: false,
        timing: enabled(options.timing),
        selfCheck: enabled(options.selfCheck),
        adaptivePractice: enabled(options.adaptivePractice),
        learningEvaluation: enabled(options.learningEvaluation),
      });
    if (path === "/api/catalog/textbooks") return json([]);
    if (path === "/api/learning-profile") return json(profileBody());

    if (path === "/api/tasks" && method === "POST")
      return json({ id: taskId });
    if (path === "/api/tasks") return json({ items: [task], total: 1 });
    if (path === `/api/tasks/${taskId}`) return json(task);
    if (path === `/api/tasks/${taskId}/items`) return json([item]);
    if (path === `/api/tasks/${taskId}/tutoring`)
      return json({
        episode: {
          id: episodeId,
          studentId,
          taskId,
          questionVersionId,
          version: 1,
          leaseEpoch: 1,
          lastSeq: 0,
          state: "active",
          teachingState: "self_check",
          exposure: "none",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          serverAt: new Date().toISOString(),
          priorExposure: false,
          timing: {
            firstAttemptMs: null,
            selfCheckMs: null,
            postHintMs: null,
            totalActiveMs: null,
            wallMs: null,
            quality: "missing",
            reasonCodes: ["not_collected"],
          },
        },
      });
    if (path === `/api/tasks/${taskId}/next-practice`)
      return json({
        decision: {
          id: "70000000-0000-4000-8000-000000000009",
          studentId,
          skillId: "90000000-0000-4000-8000-000000000001",
          goal: "review",
          entryId: "b1000000-0000-4000-8000-000000000001",
          questionVersionId: "b2000000-0000-4000-8000-000000000001",
          explanation: "这道题对应的知识到期了，先复习一遍再往前学。",
          policyVersion: "adaptive-v1",
          createdAt: new Date().toISOString(),
        },
      });
    if (path === `/api/conversations/${conversationId}/messages`) {
      if (method === "POST")
        return json({
          id: "c0000000-0000-4000-8000-000000000001",
          versionId: "c1000000-0000-4000-8000-000000000001",
        });
      return json([]);
    }
    if (path.endsWith("/latest-run")) return json(null);
    if (path === `/api/conversations/${conversationId}/runs` && method === "POST")
      return json({ runId: "90000000-0000-4000-8000-000000000001" });
    if (/^\/api\/runs\/[^/]+\/events$/.test(path))
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-store" },
        body: `data: ${JSON.stringify({ id: "1", type: "done", data: {} })}\n\n`,
      });
    if (/^\/api\/runs\/[^/]+$/.test(path))
      return json({ id: path.split("/").at(-1), status: "succeeded" });

    if (!path.startsWith("/api/admin/student-insights/"))
      return json({});

    const student = path.match(
      /^\/api\/admin\/student-insights\/students\/([^/]+)/,
    );
    if (!student) return json({ error: { code: "NOT_FOUND" } }, 404);
    const rest = path.slice(student[0].length);

    if (rest === "/overview") return json(overviewBody());
    if (rest === "/evaluation") return json(evaluationBody());
    if (rest === "/diagnosis-reviews" && method === "POST") {
      const input = request.postDataJSON() as {
        decision: string;
        correctedCode: string | null;
        reason: string;
        evidence: { kind: string; id: string }[];
      };
      diagnosisVersion += 1;
      reviews = [
        {
          id: "e0000000-0000-4000-8000-000000000001",
          decision: input.decision,
          correctedCode: input.correctedCode,
          reason: input.reason,
          evidence: input.evidence,
          createdAt: "2026-11-10T04:00:00.000Z",
        },
      ];
      return json({ reviewId: "e0000000-0000-4000-8000-000000000001", diagnosisVersion });
    }
    if (rest.startsWith("/tasks/")) {
      if (rest.endsWith("/attempts"))
        return json({
          items: [
            attemptBody({
              id: diagnosisId,
              attemptId,
              version: diagnosisVersion,
              status: diagnosisVersion > 1 ? "confirmed" : "pending",
              primaryCode: diagnosisVersion > 1 ? "concept_gap" : null,
              summary:
                diagnosisVersion > 1
                  ? "把通分后的分子加错了，属于知识缺口。"
                  : "错因还在核实，暂不确认。",
              evidence: [
                {
                  kind: "assessment",
                  id: "a1000000-0000-4000-8000-000000000001",
                },
              ],
              ruleVersion: "diagnosis-v1",
              createdAt: "2026-11-09T12:21:00.000Z",
              reviews,
            }),
          ],
          total: 1,
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
        });
      return json({
        task: {
          id: recordTaskId,
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
        items: {
          items: [],
          total: 0,
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
        },
      });
    }

    return json({ error: { code: "NOT_FOUND" } }, 404);
  });

  return { requests };
}

test("三阶段旅程：自查入口与下一题理由，再到分维度画像", async ({ page }) => {
  await mockAdaptiveLearningApi(page, {
    timing: true,
    selfCheck: true,
    adaptivePractice: true,
  });
  await page.goto(`/study/${taskId}`);

  await expect(
    page.getByRole("heading", { name: "每日5练" }),
  ).toBeVisible();
  // 阶段一：自查入口仍在，计时只作为证据，不展示快慢结论。
  const panel = page.getByRole("region", { name: "自查与提示" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/快|慢/)).toHaveCount(0);

  // 阶段二：下一题理由用学习语言解释，不暴露策略编码。
  const card = page.locator(".next-practice");
  await expect(card).toContainText("下一步：复习");
  await expect(card).toContainText("这道题对应的知识到期了，先复习一遍再往前学。");
  await expect(card).not.toContainText("policyVersion");

  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "分维度学情" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "知识掌握" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "学习习惯" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "做题效率" })).toBeVisible();
  await expect(page.getByText("比近期平时的练习用时长一些。")).toBeVisible();
});

test("计时样本不足时指标留空，不给出快慢结论", async ({ page }) => {
  await mockAdaptiveLearningApi(page, { role: "admin", learningEvaluation: true });
  await page.goto(`/admin/students/${studentId}/overview`);

  const panel = page
    .locator("section.panel")
    .filter({ hasText: "独立学习与效率证据" })
    .first();
  await expect(panel.getByText("样本 0 条")).toBeVisible();
  await expect(panel.getByText("独立新题正确率")).toBeVisible();
  await expect(panel.getByText("计时可靠率")).toBeVisible();
  // 无数据是“—”而不是 0。
  await expect(panel.getByText("—").first()).toBeVisible();
  await expect(panel.getByText("无样本").first()).toBeVisible();
  await expect(panel).not.toContainText(/\b0\s*%/);

  await expect(
    panel.getByText("暂无可比题桶；不同难度或质量层级的用时不会被合并成“速度提升”。"),
  ).toBeVisible();
  await expect(
    panel.getByText("群体参照未启用；当前只把该学生与自身冻结基线比较，不与同学横向排名。"),
  ).toBeVisible();
});

test("教师可更正错因，正误结论保持不变", async ({ page }) => {
  const api = await mockAdaptiveLearningApi(page, {
    role: "admin",
    learningEvaluation: true,
  });
  await page.goto(`/admin/students/${studentId}/records/${recordTaskId}`);

  await expect(page.getByRole("heading", { name: "分数练习" })).toBeVisible();
  await expect(page.getByText("错误 · 已核验")).toBeVisible();
  // 正误与错因分开：答错已经确认，错因仍是待确认。
  await expect(page.getByText("错因未确认")).toBeVisible();

  await page.getByLabel("复核结论").selectOption("correct");
  await page.getByLabel("纠正后的错因").selectOption("concept_gap");
  await page.getByLabel("复核说明").fill(reviewReason);
  await page.getByRole("button", { name: "提交复核" }).click();

  await expect(page.getByText("诊断第 2 版")).toBeVisible();
  const reviews = page.locator(".insight-diagnosis-reviews");
  await expect(reviews.getByText("更正错因")).toBeVisible();
  await expect(reviews.getByText("更正为知识缺口")).toBeVisible();
  await expect(reviews.getByText(reviewReason)).toBeVisible();
  // 复核只改错因，不重写已核验的正误结论。
  await expect(page.getByText("错误 · 已核验")).toBeVisible();

  const post = api.requests.find(
    (request) =>
      request.method === "POST" &&
      request.path.endsWith("/diagnosis-reviews"),
  );
  expect(post?.body).toMatchObject({
    decision: "correct",
    correctedCode: "concept_gap",
    reason: reviewReason,
  });
});

test("功能开关依次关闭后原有学习流程继续可用", async ({ page }) => {
  const api = await mockAdaptiveLearningApi(page, {
    timing: false,
    selfCheck: false,
    adaptivePractice: false,
    learningEvaluation: false,
  });
  await page.goto(`/study/${taskId}`);

  await expect(
    page.getByRole("heading", { name: "每日5练" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "自查与提示" })).toHaveCount(0);
  await expect(page.locator(".next-practice")).toHaveCount(0);

  await page.getByLabel("你的回答").fill("7/8");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect
    .poll(() =>
      api.requests.some(
        (request) =>
          request.method === "POST" &&
          request.path === `/api/conversations/${conversationId}/runs`,
      ),
    )
    .toBe(true);

  await page.goto("/profile");
  await expect(
    page.getByRole("heading", { name: "个人设置", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "分维度学情" })).toHaveCount(0);
});

test("评估开关关闭时概览不显示评测面板", async ({ page }) => {
  await mockAdaptiveLearningApi(page, {
    role: "admin",
    learningEvaluation: false,
  });
  await page.goto(`/admin/students/${studentId}/overview`);

  await expect(page.getByText("作答次数")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "独立学习与效率证据" }),
  ).toHaveCount(0);
});
