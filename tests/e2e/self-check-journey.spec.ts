import { test, expect, type Page, type Request } from "@playwright/test";
import { conversationId, studentId, taskId } from "./fixtures/ui-api";

const questionVersionId = "50000000-0000-4000-8000-000000000001";
const episodeId = "70000000-0000-4000-8000-000000000001";
const attemptId = "a0000000-0000-4000-8000-000000000001";
const mistakeId = "b0000000-0000-4000-8000-000000000001";

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

type EpisodeState = {
  version: number;
  teachingState: string;
  exposure: "none" | "guided" | "solution_exposed" | "unknown";
};

const hintText = "先看看两个分数是不是同一分母。";
const probeText = "试着只做通分这一步。";
const exampleText = "例：1/4 + 1/2 先通分再相加，得到 3/4。";
const solutionText = "解法：先通分，再相加，得到 7/8。";

const actionContent: Record<
  string,
  { content: string; teachingState: string; exposure: EpisodeState["exposure"] }
> = {
  request_hint: { content: hintText, teachingState: "focused_check", exposure: "guided" },
  request_probe: { content: probeText, teachingState: "micro_probe", exposure: "guided" },
  request_example: { content: exampleText, teachingState: "explanation", exposure: "guided" },
  request_explanation: {
    content: solutionText,
    teachingState: "independent_check",
    exposure: "solution_exposed",
  },
  pause: { content: "", teachingState: "self_check", exposure: "none" },
  resume: { content: "", teachingState: "self_check", exposure: "none" },
};

type Options = { selfCheck?: boolean };

async function mockSelfCheckApi(page: Page, options: Options = {}) {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const state: EpisodeState = {
    version: 1,
    teachingState: "self_check",
    exposure: "none",
  };
  let lastAction: Record<string, unknown> | null = null;

  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    let body: unknown = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = request.postData();
    }
    requests.push({ path: url.pathname, method: request.method(), body });
  });

  const episode = () => ({
    id: episodeId,
    studentId,
    taskId,
    questionVersionId,
    version: state.version,
    leaseEpoch: 1,
    lastSeq: 0,
    state: "active",
    teachingState: state.teachingState,
    exposure: state.exposure,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    serverAt: new Date().toISOString(),
    priorExposure: state.exposure !== "none",
    timing: {
      firstAttemptMs: null,
      selfCheckMs: null,
      postHintMs: null,
      totalActiveMs: null,
      wallMs: null,
      quality: "missing",
      reasonCodes: ["not_collected"],
    },
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let status = 200;
    let body: unknown = {};

    if (path === "/api/auth/session")
      body = { actor: { userId: studentId, role: "student" }, studentId };
    else if (path === "/api/students")
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
        llmConfigured: true,
        uploadsConfigured: false,
        ocrConfigured: false,
        selfCheck: options.selfCheck === false ? "disabled" : "enabled",
      };
    else if (path === "/api/tasks") body = { items: [task], total: 1 };
    else if (path === `/api/tasks/${taskId}`) body = task;
    else if (path === `/api/tasks/${taskId}/items`) body = [item];
    else if (path === `/api/tasks/${taskId}/tutoring`) body = { episode: episode() };
    else if (path.endsWith("/messages")) body = [];
    else if (path.endsWith("/latest-run")) body = null;
    else if (/^\/api\/tutoring\/episodes\/[^/]+\/actions$/.test(path)) {
      const input = request.postDataJSON() as {
        expectedVersion: number;
        kind: keyof typeof actionContent;
      };
      const next = actionContent[input.kind];
      if (!next) {
        status = 422;
        body = { error: { code: "VALIDATION", message: "未知动作" } };
      } else if (input.expectedVersion !== state.version) {
        status = 409;
        body = {
          error: { code: "CONFLICT", message: "状态已更新，请刷新后重试" },
        };
      } else {
        state.version += 1;
        state.teachingState = next.teachingState;
        if (next.exposure !== "none") state.exposure = next.exposure;
        lastAction = {
          id: `70000000-0000-4000-8000-0000000000${state.version}`,
          episodeId,
          stateVersion: state.version,
          state: state.teachingState,
          exposure: state.exposure,
          displayStatus: next.content ? "sent" : "acknowledged",
          content: next.content,
          evidence: [],
        };
        body = lastAction;
      }
    } else if (/^\/api\/tutoring\/episodes\/[^/]+\/actions\/[^/]+\/acknowledge$/.test(path))
      body = { ...(lastAction ?? {}), displayStatus: "acknowledged" };
    else if (path.endsWith("/runs") && request.method() === "POST")
      body = { runId: "90000000-0000-4000-8000-000000000001" };
    else if (/^\/api\/runs\/[^/]+\/events$/.test(path)) {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-store" },
        body: `data: ${JSON.stringify({ id: "1", type: "done", data: {} })}\n\n`,
      });
      return;
    } else if (/^\/api\/runs\/[^/]+$/.test(path))
      body = { id: path.split("/").at(-1), status: "succeeded" };
    else body = {};

    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  return {
    requests,
    state,
  };
}

async function openStudy(page: Page) {
  await page.goto(`/study/${taskId}`);
  await expect(
    page.getByRole("heading", { name: "每日5练" }),
  ).toBeVisible();
}

test("walks a wrong step through a self check into an independent variant", async ({
  page,
}) => {
  const api = await mockSelfCheckApi(page);
  await openStudy(page);

  const panel = page.getByRole("region", { name: "自查与提示" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("自查进行中 · 自查")).toBeVisible();

  await panel.getByRole("button", { name: "自查一下" }).click();
  await expect(panel.getByText(hintText)).toBeVisible();
  await expect(panel.getByText("已接触解法")).toHaveCount(0);

  await panel.getByRole("button", { name: "聚焦检查" }).click();
  await expect(panel.getByText(probeText)).toBeVisible();
  await expect(panel.getByText("自查进行中 · 微题")).toBeVisible();

  const actions = api.requests.filter((r) =>
    /\/api\/tutoring\/episodes\/[^/]+\/actions$/.test(r.path),
  );
  expect(actions.map((r) => (r.body as { kind: string }).kind)).toEqual([
    "request_hint",
    "request_probe",
  ]);
  // 第二层用的是刷新后的版本号，而不是开头读到的旧版本。
  expect((actions[1]!.body as { expectedVersion: number }).expectedVersion).toBe(
    2,
  );

  await page.getByLabel("你的回答").fill("我先通分，3/4=6/8，所以 6/8+1/8=7/8");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect
    .poll(
      () =>
        api.requests.filter(
          (r) =>
            r.path === `/api/conversations/${conversationId}/runs` &&
            r.method === "POST",
        ).length,
    )
    .toBe(1);
  // 自己走回来的一步仍保留原题的带提示记录，不冒充独立掌握。
  await expect(panel.getByText("自查进行中 · 微题")).toBeVisible();
});

test("shows that a requested explanation is not independent mastery", async ({
  page,
}) => {
  const api = await mockSelfCheckApi(page);
  await openStudy(page);

  const panel = page.getByRole("region", { name: "自查与提示" });
  await panel.getByRole("button", { name: "请完整讲解" }).click();

  await expect(panel.getByText(solutionText)).toBeVisible();
  await expect(
    panel.getByRole("status").filter({ hasText: "不算独立掌握" }),
  ).toBeVisible();
  await expect(
    panel.locator(".tutoring-content .badge", { hasText: "已接触解法" }),
  ).toBeVisible();

  // 讲解显示后立即登记阅读回执；失败也不阻断学生继续做题。
  await expect
    .poll(() =>
      api.requests.some((r) => r.path.endsWith("/acknowledge")),
    )
    .toBe(true);

  await page.getByLabel("你的回答").fill("7/8");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect
    .poll(() =>
      api.requests.some(
        (r) =>
          r.path === `/api/conversations/${conversationId}/runs` &&
          r.method === "POST",
      ),
    )
    .toBe(true);
  await expect(
    panel.getByRole("status").filter({ hasText: "不算独立掌握" }),
  ).toBeVisible();
});

test("keeps the previous study screen when self check is turned off", async ({
  page,
}) => {
  const api = await mockSelfCheckApi(page, { selfCheck: false });
  await openStudy(page);

  await expect(page.getByRole("region", { name: "自查与提示" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "自查一下" })).toHaveCount(0);
  expect(
    api.requests.some((r) => r.path === `/api/tasks/${taskId}/tutoring`),
  ).toBe(false);

  await page.getByLabel("你的回答").fill("等于 7/8");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect
    .poll(() =>
      api.requests.some(
        (r) =>
          r.path === `/api/conversations/${conversationId}/runs` &&
          r.method === "POST",
      ),
    )
    .toBe(true);
});

test("keeps an unproven diagnosis explicitly pending", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) requests.push(url.pathname);
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let body: unknown = {};
    if (path === "/api/auth/session")
      body = { actor: { userId: studentId, role: "student" }, studentId };
    else if (path === "/api/students")
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
        selfCheck: "enabled",
      };
    else if (path === `/api/mistakes/${mistakeId}`)
      body = {
        id: mistakeId,
        questionId: "c0000000-0000-4000-8000-000000000001",
        questionVersionId,
        stem: "3/4 + 1/8 等于多少？",
        status: "learning",
        dueAt: null,
        version: 2,
        originalAttemptId: attemptId,
        hasImageEvidence: false,
      };
    else if (path === `/api/mistakes/${mistakeId}/history`)
      body = [
        {
          id: "d0000000-0000-4000-8000-000000000001",
          attemptId,
          fromState: "unresolved",
          toState: "learning",
          reason: "第一次重做仍未写全步骤",
          evidenceAt: new Date().toISOString(),
          type: "redone",
        },
      ];
    else if (path === `/api/question-versions/${questionVersionId}/sources`)
      body = [];
    else if (path === `/api/attempts/${attemptId}`)
      body = {
        answer: "1/2",
        questionStem: "3/4 + 1/8 等于多少？",
        messageContent: "3/4 + 1/8 = 1/2",
        hints: [],
      };
    else if (path === `/api/attempts/${attemptId}/diagnosis`)
      body = {
        diagnosis: {
          id: "e0000000-0000-4000-8000-000000000001",
          attemptId,
          version: 1,
          status: "needs_probe",
          primaryCode: null,
          summary: "只看到最终答案，暂时无法区分是通分错误还是相加错误。",
          nextStep: "先把通分那一步写出来，再做判断。",
          evidence: [{ kind: "attempt", id: attemptId }],
        },
      };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.goto(`/mistakes/${mistakeId}`);
  await expect(page.getByRole("heading", { name: "错题详情" })).toBeVisible();
  await page.getByRole("button", { name: "查看本次作答与提示" }).click();

  const panel = page.getByRole("region", { name: "错因诊断摘要" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("需要补充过程")).toBeVisible();
  await expect(panel.getByText("先把通分那一步写出来，再做判断。")).toBeVisible();
  await expect(panel.getByText("依据 1 条")).toBeVisible();
  await expect(panel.getByText("不代表教师复核结论")).toBeVisible();
  // 原始候选推理不直接展示给学生。
  await expect(panel.getByText(/hypothesis|supported|rejected/)).toHaveCount(0);
});
