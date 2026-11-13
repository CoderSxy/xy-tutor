import { test, expect, type Page, type Request } from "@playwright/test";
import { studentId, taskId, conversationId } from "./fixtures/ui-api";

const questionVersionId = "50000000-0000-4000-8000-000000000001";
const episodeId = "70000000-0000-4000-8000-000000000001";

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

function episode(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

type Options = {
  timing?: boolean;
  /** 第一个 POST /api/tutoring/episodes 返回接管冲突。 */
  conflictOnStart?: boolean;
  /** 提交回执附带计时降级提示。 */
  timingWarning?: string | null;
};

async function mockTimingApi(page: Page, options: Options = {}) {
  const requests: { path: string; method: string; body: unknown }[] = [];
  let started = false;
  const epoch = 1;
  let lastSeq = 0;
  let conflict = options.conflictOnStart ?? false;

  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    let body: unknown = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = request.postData();
    }
    requests.push({
      path: url.pathname,
      method: request.method(),
      body,
    });
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
        ...(options.timing === false ? {} : { timing: "enabled" }),
      };
    else if (path === "/api/tasks" && request.method() === "POST") body = task;
    else if (path === "/api/tasks") body = { items: [task], total: 1 };
    else if (path === `/api/tasks/${taskId}`) body = task;
    else if (path === `/api/tasks/${taskId}/items`) body = [item];
    else if (path.endsWith("/messages")) body = [];
    else if (path.endsWith("/latest-run")) body = null;
    else if (path === "/api/tutoring/episodes" && request.method() === "POST") {
      const input = request.postDataJSON() as { takeOver?: boolean };
      if (conflict && !input.takeOver) {
        status = 409;
        body = {
          error: { code: "CONFLICT", message: "已有进行中的作答" },
        };
      } else {
        conflict = false;
        started = true;
        lastSeq = 0;
        body = episode({ leaseEpoch: epoch });
      }
    } else if (/^\/api\/tutoring\/episodes\/[^/]+\/events$/.test(path)) {
      const input = request.postDataJSON() as {
        events: { seq: number; leaseEpoch: number }[];
      };
      if (!started || input.events.some((e) => e.leaseEpoch !== epoch)) {
        status = 409;
        body = {
          error: { code: "CONFLICT", message: "作答租约已被接管" },
        };
      } else {
        lastSeq = Math.max(lastSeq, ...input.events.map((e) => e.seq));
        body = episode({ leaseEpoch: epoch, lastSeq, version: 2 });
      }
    } else if (/^\/api\/tutoring\/episodes\/[^/]+$/.test(path))
      body = episode({ leaseEpoch: epoch, lastSeq });
    else if (path.endsWith("/runs") && request.method() === "POST")
      body = {
        runId: "90000000-0000-4000-8000-000000000001",
        ...(options.timingWarning
          ? { timingWarning: options.timingWarning }
          : {}),
      };
    else if (/^\/api\/runs\/[^/]+\/events$/.test(path)) {
      status = 200;
      await route.fulfill({
        status,
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

  return { requests, setConflict: (value: boolean) => void (conflict = value) };
}

async function openStudy(page: Page) {
  await page.goto(`/study/${taskId}`);
  await expect(
    page.getByRole("heading", { name: "每日5练" }),
  ).toBeVisible();
}

test("times open-question work without watching for input", async ({ page }) => {
  const api = await mockTimingApi(page);
  await openStudy(page);

  const startButton = page.getByRole("button", {
    name: "开始记录本题的作答时间",
  });
  await expect(startButton).toBeVisible();
  await startButton.click();

  await expect(
    page.getByRole("status").filter({ hasText: "正在记录作答时间" }),
  ).toBeVisible();
  // 不输入任何内容，只读题或打草稿时间也要继续走。
  await page.waitForTimeout(1500);
  await expect(
    page.getByRole("status").filter({ hasText: "正在记录作答时间 · 0:0" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "暂停记录本题作答时间" }),
  ).toBeVisible();

  const started = api.requests.find(
    (r) => r.path === "/api/tutoring/episodes" && r.method === "POST",
  );
  expect(started?.body).toMatchObject({ taskId, questionVersionId });
});

test("pauses while the tab is in the background and resumes on request", async ({
  page,
}) => {
  await mockTimingApi(page);
  await openStudy(page);
  await page
    .getByRole("button", { name: "开始记录本题的作答时间" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "正在记录作答时间" }),
  ).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(
    page.getByRole("status").filter({ hasText: "页面不在前台的时间不算作答" }),
  ).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // 回到前台不等于自动继续，学生自己决定。
  await expect(
    page.getByRole("status").filter({ hasText: "页面不在前台的时间不算作答" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续记录本题作答时间" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "正在记录作答时间" }),
  ).toBeVisible();
});

test("does not count the tutor's reply time as answer time", async ({
  page,
}) => {
  await mockTimingApi(page);
  await openStudy(page);
  await page
    .getByRole("button", { name: "开始记录本题的作答时间" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "正在记录作答时间" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "给我一个提示" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "等讲解的时间不算你的作答时间" }),
  ).toBeVisible();
});

test("hands the episode to the answer and shows a timing warning", async ({
  page,
}) => {
  const api = await mockTimingApi(page, {
    timingWarning: "最终计时事件已过期，本次计时质量降级",
  });
  await openStudy(page);
  await page
    .getByRole("button", { name: "开始记录本题的作答时间" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "正在记录作答时间" }),
  ).toBeVisible();

  await page.getByLabel("你的回答").fill("等于 7/8");
  await page.getByRole("button", { name: "发送消息" }).click();

  await expect(
    page.getByRole("status").filter({ hasText: "本次计时质量降级" }),
  ).toBeVisible();

  const submitted = api.requests.find(
    (r) =>
      r.path === `/api/conversations/${conversationId}/runs` &&
      r.method === "POST",
  );
  expect(submitted?.body).toMatchObject({
    message: "等于 7/8",
    questionVersionId,
    episodeId,
  });
  expect(
    (submitted?.body as { timingFinalEvent?: { kind?: string } })
      ?.timingFinalEvent?.kind,
  ).toBe("finish");
});

test("offers to take over when another window holds the lease", async ({
  page,
}) => {
  const api = await mockTimingApi(page, { conflictOnStart: true });
  await openStudy(page);

  await page.getByRole("button", { name: "开始记录本题的作答时间" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "另一个窗口正在记录这道题" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "在这里接管这道题的计时" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "正在记录作答时间" }),
  ).toBeVisible();
  const starts = api.requests.filter(
    (r) => r.path === "/api/tutoring/episodes" && r.method === "POST",
  );
  expect(starts.map((r) => (r.body as { takeOver?: boolean }).takeOver)).toEqual(
    [undefined, true],
  );
});

test("still answers when timing is turned off", async ({ page }) => {
  const api = await mockTimingApi(page, { timing: false });
  await openStudy(page);

  await expect(
    page.getByRole("button", { name: "开始记录本题的作答时间" }),
  ).toHaveCount(0);
  await page.getByLabel("你的回答").fill("等于 7/8");
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
  const submitted = api.requests.find(
    (r) => r.path === `/api/conversations/${conversationId}/runs`,
  );
  expect(submitted?.body).toMatchObject({ message: "等于 7/8" });
  expect(submitted?.body).not.toHaveProperty("episodeId");
  expect(submitted?.body).not.toHaveProperty("timingFinalEvent");
});
