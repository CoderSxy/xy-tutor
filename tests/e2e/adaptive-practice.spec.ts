import { expect, test, type Page } from "@playwright/test";
import {
  conversationId,
  mockLearningApi,
  studentId,
  taskId,
} from "./fixtures/ui-api";

const skillId = "50000000-0000-4000-8000-000000000001";
const decisionId = "70000000-0000-4000-8000-000000000001";
const reviewExplanation = "这道题对应的知识到期了，先复习一遍再往前学。";

type Profile = {
  studentId: string;
  skillId: string;
  version: number;
  stale: boolean;
  trainingBand: "repair" | "consolidation" | "advance";
  recentIndependentCorrect: number;
  recentDeterminateCount: number;
  efficiency: {
    status: "insufficient_samples" | "observed";
    baselineId: string | null;
    sampleCount: number;
    medianMs: number | null;
    timeRatio: number | null;
    direction: "faster" | "comparable" | "slower" | null;
    reasonCodes: string[];
  };
  habits?: {
    anchorCode: string;
    independentCheckCount: number;
    successfulCorrectionCount: number;
  }[];
  evidence: { kind: string; id: string; versionId: string }[];
};

const emptyProfile: Profile = {
  studentId,
  skillId,
  version: 3,
  stale: false,
  trainingBand: "repair",
  recentIndependentCorrect: 0,
  recentDeterminateCount: 0,
  efficiency: {
    status: "insufficient_samples",
    baselineId: null,
    sampleCount: 0,
    medianMs: null,
    timeRatio: null,
    direction: null,
    reasonCodes: ["SAMPLES_BELOW_MINIMUM"],
  },
  habits: [],
  evidence: [],
};

async function mockAdaptiveApi(
  page: Page,
  options: { profiles: Profile[]; enabled: boolean },
) {
  await mockLearningApi(page, "student");
  const state = { posts: [] as { requestKey?: string; expectedProfileVersion?: number }[] };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    let body: unknown = {};
    const status = 200;
    const decision = {
      id: decisionId,
      studentId,
      skillId,
      goal: "review",
      entryId: "b1000000-0000-4000-8000-000000000001",
      questionVersionId: "b2000000-0000-4000-8000-000000000001",
      explanation: reviewExplanation,
      policyVersion: "adaptive-v1",
      createdAt: new Date().toISOString(),
    };
    if (path === "/api/auth/session" || path === "/api/auth/login") {
      body = { actor: { userId: studentId, role: "student" }, studentId };
    } else if (path === "/api/capabilities") {
      body = options.enabled
        ? { llmConfigured: false, adaptivePractice: "enabled" }
        : { llmConfigured: false };
    } else if (path === `/api/tasks/${taskId}`) {
      body = {
        id: taskId,
        studentId,
        revisionId: "20000000-0000-4000-8000-000000000001",
        kind: "daily_practice",
        status: "active",
        version: 1,
        conversationId,
      };
    } else if (path === `/api/tasks/${taskId}/items`) {
      body = [];
    } else if (path === "/api/learning-profile") {
      body = options.profiles;
    } else if (path === `/api/tasks/${taskId}/next-practice`) {
      if (method === "POST") {
        state.posts.push(request.postDataJSON());
        body = { decision };
      } else {
        body = { decision };
      }
    } else {
      // 交给 mockLearningApi 已注册的处理器
      await route.fallback();
      return;
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  return state;
}

test("学习页展示可理解的推荐理由，并可安排下一题", async ({ page }) => {
  const state = await mockAdaptiveApi(page, {
    enabled: true,
    profiles: [emptyProfile],
  });
  await page.goto(`/study/${taskId}`);

  const card = page.locator(".next-practice");
  await expect(card).toContainText("下一步：复习");
  await expect(card).toContainText(reviewExplanation);
  await expect(card).not.toContainText("review");
  await expect(card).not.toContainText("policyVersion");

  await card.getByRole("button", { name: "安排下一题" }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0]?.expectedProfileVersion).toBe(emptyProfile.version);
  expect(typeof state.posts[0]?.requestKey).toBe("string");
  await expect(card).toContainText("下一步：复习");
});

test("个人页按知识、习惯、效率分开显示", async ({ page }) => {
  await mockAdaptiveApi(page, {
    enabled: true,
    profiles: [
      {
        ...emptyProfile,
        trainingBand: "consolidation",
        recentIndependentCorrect: 3,
        recentDeterminateCount: 5,
        efficiency: {
          status: "observed",
          baselineId: "80000000-0000-4000-8000-000000000001",
          sampleCount: 6,
          medianMs: 92000,
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
      },
    ],
  });
  await page.goto("/profile");
  await expect(
    page.getByRole("heading", { name: "个人设置", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "分维度学情" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "知识掌握" })).toBeVisible();
  await expect(page.getByText(/近期 5 道可判断的练习里，独立答对 3 道/)).toBeVisible();
  await expect(page.getByText(/当前正在巩固/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "学习习惯" })).toBeVisible();
  await expect(
    page.getByText("关键步骤落纸：自查 2 次，修正成功 1 次。"),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "做题效率" })).toBeVisible();
  await expect(
    page.getByText("比近期平时的练习用时长一些。"),
  ).toBeVisible();
  await expect(page.getByText(/\b0\s*分\b/)).toHaveCount(0);
});

test("样本不足时不显示分数或快慢结论", async ({ page }) => {
  await mockAdaptiveApi(page, { enabled: true, profiles: [emptyProfile] });
  await page.goto("/profile");
  const section = page
    .locator("section.panel")
    .filter({ hasText: "分维度学情" })
    .first();
  await expect(
    section.getByText(/还在积累可比较的练习，完成独立作答后这里会显示掌握情况/),
  ).toBeVisible();
  await expect(
    section.getByText(/还在积累可比较的练习，计时样本不足时不显示快慢结论/),
  ).toBeVisible();
  await expect(
    section.getByText("还没有记录到自查动作；做错后按提示自查一次，这里会留下记录。"),
  ).toBeVisible();
});

test("开关关闭时不留下失效入口", async ({ page }) => {
  await mockAdaptiveApi(page, { enabled: false, profiles: [emptyProfile] });
  await page.goto(`/study/${taskId}`);
  await expect(
    page.getByRole("heading", { name: "每日5练", level: 1 }),
  ).toBeVisible();
  await expect(page.locator(".next-practice")).toHaveCount(0);
  await page.goto("/profile");
  await expect(
    page.getByRole("heading", { name: "个人设置", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "分维度学情" })).toHaveCount(0);
});
