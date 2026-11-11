import { createCanvas } from "@napi-rs/canvas";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  mockLearningApi,
  retryRunId,
  revisionId,
  runId,
  studentId,
} from "./fixtures/ui-api";

const seedTaskId = "30000000-0000-4000-8000-000000000002";
const seedConversationId = "40000000-0000-4000-8000-000000000002";
const draftTaskId = "30000000-0000-4000-8000-000000000011";
const draftConversationId = "40000000-0000-4000-8000-000000000011";
const now = "2026-11-09T08:00:00.000Z";
const PNG = (() => {
  const canvas = createCanvas(320, 240);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 320, 240);
  ctx.fillStyle = "#1a1a1a";
  ctx.font = "36px sans-serif";
  ctx.fillText("7+5=12", 24, 140);
  return canvas.toBuffer("image/png");
})();
const image = (name: string) => ({ name, mimeType: "image/png", buffer: PNG });

type Task = {
  id: string;
  studentId: string;
  revisionId: string;
  kind: string;
  title: string | null;
  status: string;
  version: number;
  conversationId: string;
  chapterId: string | null;
  createdAt: string;
  updatedAt: string;
};

type Attachment = {
  fileId: string;
  name: string;
  mimeType: string;
  width: number;
  height: number;
  position: number;
};

type HistoryMessage = {
  id: string;
  versionId: string;
  versionNo: number;
  content: string;
  role: "user" | "assistant";
  attachments: Attachment[];
  versions: {
    id: string;
    versionNo: number;
    content: string;
    attachments: Attachment[];
  }[];
};

type Download = { url: string; expiresAt: string; contentType?: string };

type Plan = {
  failUploads?: boolean;
  uploadDelayMs?: number;
  history?: HistoryMessage[];
  downloads?: Download[];
  downloadDelayMs?: number;
  failFirstRun?: boolean;
};

const future = () => new Date(Date.now() + 300_000).toISOString();
const expired = () => new Date(Date.now() - 60_000).toISOString();

function attachment(fileId: string, position: number): Attachment {
  return {
    fileId,
    name: `图片${position + 1}.png`,
    mimeType: "image/png",
    width: 320,
    height: 240,
    position,
  };
}

function historyMessage(
  n: number,
  role: "user" | "assistant",
  content: string,
  fileIds: string[] = [],
): HistoryMessage {
  const id = `70000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const versionId = `71000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const attachments = fileIds.map(attachment);
  return {
    id,
    versionId,
    versionNo: 1,
    content,
    role,
    attachments,
    versions: [{ id: versionId, versionNo: 1, content, attachments }],
  };
}

function reply(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function setupChat(page: Page, plan: Plan = {}) {
  await mockLearningApi(page);
  const state = {
    grants: [] as { fileId: string; body: Record<string, unknown> }[],
    completions: [] as string[],
    runs: [] as Record<string, unknown>[],
    retries: [] as { runId: string; body: Record<string, unknown> }[],
    downloads: [] as string[],
    creations: 0,
  };
  const messages: HistoryMessage[] = [...(plan.history ?? [])];
  const seed: Task = {
    id: seedTaskId,
    studentId,
    revisionId,
    kind: "daily_practice",
    title: "之前的会话",
    status: "active",
    version: 1,
    conversationId: seedConversationId,
    chapterId: null,
    createdAt: now,
    updatedAt: now,
  };
  const drafts = new Map<string, Task>();
  let uploadSeq = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/api/capabilities")
      return reply(route, 200, {
        llmConfigured: true,
        uploadsConfigured: true,
        ocrConfigured: false,
        images: "enabled-unverified",
      });
    if (path === "/api/tasks" && method === "POST") {
      const body = request.postDataJSON() as {
        creationKey?: string;
        kind?: string;
      };
      const key = body.creationKey ?? "no-key";
      let task = drafts.get(key);
      if (!task) {
        state.creations += 1;
        task = {
          id: draftTaskId,
          studentId,
          revisionId,
          kind: body.kind ?? "free_question",
          title: null,
          status: "active",
          version: 1,
          conversationId: draftConversationId,
          chapterId: null,
          createdAt: now,
          updatedAt: now,
        };
        drafts.set(key, task);
      }
      return reply(route, 200, task);
    }
    if (path === "/api/tasks" && method === "GET")
      return reply(route, 200, {
        items: [...drafts.values(), seed],
        total: drafts.size + 1,
      });
    if (path.startsWith("/api/tasks/")) {
      const rest = path.slice("/api/tasks/".length);
      if (rest.endsWith("/items")) return reply(route, 200, []);
      if (rest.endsWith("/summary")) return reply(route, 200, null);
      const task =
        rest === seedTaskId
          ? seed
          : [...drafts.values()].find((t) => t.id === rest);
      if (task) return reply(route, 200, task);
    }
    if (path === "/api/uploads" && method === "POST") {
      if (plan.uploadDelayMs)
        await new Promise((resolve) => setTimeout(resolve, plan.uploadDelayMs));
      if (plan.failUploads)
        return reply(route, 503, {
          error: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "对象存储暂时不可用",
          },
        });
      uploadSeq += 1;
      const fileId = `50000000-0000-4000-8000-${String(uploadSeq).padStart(12, "0")}`;
      state.grants.push({
        fileId,
        body: request.postDataJSON() as Record<string, unknown>,
      });
      return reply(route, 200, {
        fileId,
        key: `conversation_image/${fileId}`,
        url: `/test-uploads/${fileId}`,
        headers: { "content-type": "image/jpeg" },
        expiresAt: now,
      });
    }
    const complete = /^\/api\/uploads\/([^/]+)\/complete$/.exec(path);
    if (complete && method === "POST") {
      state.completions.push(complete[1]!);
      return reply(route, 200, {});
    }
    const download = /^\/api\/files\/([^/]+)\/download$/.exec(path);
    if (download && method === "GET") {
      if (plan.downloadDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, plan.downloadDelayMs),
        );
      const index = state.downloads.length;
      state.downloads.push(download[1]!);
      const entry: Download = plan.downloads?.[index] ?? {
        url: `/test-media/${download[1]}.png`,
        expiresAt: future(),
      };
      return reply(route, 200, {
        url: entry.url,
        contentType: entry.contentType ?? "image/png",
        expiresAt: entry.expiresAt,
      });
    }
    if (/^\/api\/conversations\/[^/]+\/latest-run$/.test(path))
      return reply(
        route,
        200,
        state.runs.length
          ? {
              id: runId,
              status: plan.failFirstRun ? "failed" : "succeeded",
              content: null,
            }
          : null,
      );
    if (/^\/api\/conversations\/[^/]+\/runs$/.test(path) && method === "POST") {
      const body = request.postDataJSON() as {
        message?: string;
        attachmentIds?: string[];
        requestKey?: string;
      };
      state.runs.push(body);
      messages.push(
        historyMessage(
          900 + state.runs.length,
          "user",
          body.message ?? "",
          body.attachmentIds ?? [],
        ),
      );
      return reply(route, 200, { runId });
    }
    const retryRoute = /^\/api\/runs\/([^/]+)\/retry$/.exec(path);
    if (retryRoute && method === "POST") {
      state.retries.push({
        runId: retryRoute[1]!,
        body: request.postDataJSON() as Record<string, unknown>,
      });
      return reply(route, 200, { runId: retryRunId });
    }
    if (/^\/api\/runs\/[^/]+\/events$/.test(path)) {
      const id = path.split("/")[3];
      const failed = !!plan.failFirstRun && id === runId;
      const event = failed
        ? {
            id: "2",
            type: "failed",
            data: { message: "回答暂时中断，可稍后继续" },
          }
        : { id: "3", type: "done", data: {} };
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      });
    }
    if (/^\/api\/runs\/[^/]+$/.test(path)) {
      const id = path.split("/")[3]!;
      return reply(route, 200, {
        id,
        status: plan.failFirstRun && id === runId ? "failed" : "succeeded",
        content: null,
      });
    }
    if (path.endsWith("/messages")) return reply(route, 200, messages);
    return route.fallback();
  });
  await page.route("**/test-uploads/**", (route) =>
    route.fulfill({ status: 200, body: "" }),
  );
  await page.route("**/test-media/**", (route) =>
    route.request().url().includes("stale")
      ? route.fulfill({ status: 404, body: "" })
      : route.fulfill({
          status: 200,
          contentType: "image/png",
          body: PNG,
        }),
  );
  return state;
}

async function openHome(page: Page) {
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill("student");
  await page.getByLabel("密码", { exact: true }).fill("long-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "选一个方向，或者直接说出来。" }),
  ).toBeVisible();
}

test("preserves_draft_on_upload_failure", async ({ page }) => {
  await setupChat(page, { failUploads: true });
  await openHome(page);
  const rail = page.getByRole("complementary", { name: "历史学习会话" });
  await page.getByLabel("你的回答").fill("这道题怎么写");
  await page.getByLabel("选择图片文件").setInputFiles(image("作业.png"));
  await expect(
    page.getByRole("alert").filter({ hasText: "对象存储暂时不可用" }),
  ).toBeVisible();
  await expect(page.getByText("上传失败", { exact: true })).toBeVisible();
  await expect(page.getByLabel("你的回答")).toHaveValue("这道题怎么写");
  await expect(page.getByRole("button", { name: "发送消息" })).toBeDisabled();
  await expect(rail.getByText("未开始", { exact: true })).toBeVisible();
});

test("drops_late_upload_after_conversation_switch", async ({ page }) => {
  const chat = await setupChat(page, { uploadDelayMs: 1200 });
  await openHome(page);
  const rail = page.getByRole("complementary", { name: "历史学习会话" });
  const previous = rail.getByRole("button", { name: /之前的会话/ });
  await expect(previous).toBeVisible();
  await page.getByLabel("选择图片文件").setInputFiles(image("延迟.png"));
  await previous.click();
  await expect(page.getByRole("heading", { name: "每日5练" })).toBeVisible();
  await expect(page.locator('img[alt="待发送图片"]')).toHaveCount(0);
  await page.waitForTimeout(1600);
  await expect(page.locator('img[alt="待发送图片"]')).toHaveCount(0);
  expect(chat.completions).toHaveLength(0);
});

test("rotated_file_is_uploaded_as_new_sealed_asset", async ({ page }) => {
  const chat = await setupChat(page);
  await openHome(page);
  await page.getByLabel("选择图片文件").setInputFiles(image("旋转.png"));
  await expect(page.getByText("已就绪", { exact: true })).toBeVisible();
  await expect.poll(() => chat.grants.length).toBe(1);
  const firstId = chat.grants[0]!.fileId;
  await page.getByRole("button", { name: "旋转第1张图片" }).click();
  await expect.poll(() => chat.grants.length).toBe(2);
  const secondId = chat.grants[1]!.fileId;
  expect(secondId).not.toBe(firstId);
  await expect(page.getByText("已就绪", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送消息" })).toBeEnabled();
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect.poll(() => chat.runs.length).toBe(1);
  expect(chat.runs[0]).toMatchObject({
    message: "",
    attachmentIds: [secondId],
  });
  await expect(page).toHaveURL(new RegExp(`/study/${draftTaskId}`));
  await expect.poll(() => chat.completions).toContain(secondId);
});

test("caps_a_message_at_three_images_and_sends_without_text", async ({
  page,
}) => {
  const chat = await setupChat(page);
  await openHome(page);
  await page
    .getByLabel("选择图片文件")
    .setInputFiles([
      image("1.png"),
      image("2.png"),
      image("3.png"),
      image("4.png"),
    ]);
  await expect(page.getByRole("alert")).toContainText("最多 3 张");
  const tray = page.getByRole("group", { name: "待发送图片" });
  await expect(tray.locator("img")).toHaveCount(3);
  await expect(page.getByText("已就绪", { exact: true })).toHaveCount(3);
  await expect.poll(() => chat.grants.length).toBe(3);
  await expect(page.getByRole("button", { name: "发送消息" })).toBeEnabled();
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect.poll(() => chat.runs.length).toBe(1);
  expect(chat.runs[0]!.message).toBe("");
  expect(chat.runs[0]!.attachmentIds).toHaveLength(3);
});

test("preview_before_send_and_after_reload", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await setupChat(page);
  await openHome(page);
  await page.getByLabel("选择图片文件").setInputFiles(image("作业.png"));
  await expect(page.getByText("已就绪", { exact: true })).toBeVisible();
  const trigger = page.getByRole("button", { name: "预览第1张图片" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "图片预览" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("img")).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page).toHaveURL(new RegExp(`/study/${draftTaskId}`));
  await expect(
    page.getByRole("button", { name: "预览第1张图片" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "预览第1张图片" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "预览第1张图片" }).click();
  await expect(page.getByRole("dialog", { name: "图片预览" })).toBeVisible();
  await page.getByRole("button", { name: "关闭图片预览" }).click();
  await expect(page.getByRole("dialog", { name: "图片预览" })).toBeHidden();
});

test("refreshes_expired_image_link_once", async ({ page }) => {
  const fileId = "50000000-0000-4000-8000-000000000099";
  const chat = await setupChat(page, {
    history: [historyMessage(1, "user", "这是我的作答", [fileId])],
    downloads: [
      { url: "/test-media/stale.png", expiresAt: expired() },
      { url: "/test-media/fresh.png", expiresAt: future() },
    ],
  });
  await openHome(page);
  await page.goto(`/study/${seedTaskId}`);
  await expect(
    page.getByRole("button", { name: "预览第1张图片" }).locator("img"),
  ).toHaveAttribute("src", "/test-media/fresh.png");
  await expect.poll(() => chat.downloads.length).toBe(2);
});

test("image_load_keeps_history_scroll_position", async ({ page }) => {
  const fileId = "50000000-0000-4000-8000-000000000098";
  const history = Array.from({ length: 12 }, (_, index) =>
    historyMessage(
      index + 1,
      index % 2 ? "assistant" : "user",
      `第 ${index + 1} 条历史消息，记录这一题的想法和步骤。`.repeat(4),
    ),
  );
  history.push(historyMessage(13, "user", "最后一题的作答", [fileId]));
  await setupChat(page, { history, downloadDelayMs: 1200 });
  await openHome(page);
  await page.goto(`/study/${seedTaskId}`);
  const log = page.locator(".tutor-log");
  await expect(log).toBeVisible();
  await expect(log.locator("article").last()).toBeVisible();
  await log.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const img = document.querySelector(
          ".message-images img",
        ) as HTMLImageElement | null;
        return img?.naturalWidth ?? 0;
      }),
    )
    .toBeGreaterThan(0);
  await expect.poll(() => log.evaluate((node) => node.scrollTop)).toBe(0);
});

test("retry_failed_run_does_not_duplicate_user_message", async ({ page }) => {
  const chat = await setupChat(page, { failFirstRun: true });
  await openHome(page);
  await page.getByLabel("你的回答").fill("这道题我不会");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page).toHaveURL(new RegExp(`/study/${draftTaskId}`));
  const retry = page.getByRole("button", { name: "重新回答" });
  await expect(retry).toBeVisible();
  await expect(page.locator(".message-user")).toHaveCount(1);
  await page.reload();
  await expect(retry).toBeVisible();
  await retry.click();
  await expect.poll(() => chat.retries.length).toBe(1);
  expect(chat.runs).toHaveLength(1);
  expect(chat.retries[0]!.body.requestKey).not.toBe(chat.runs[0]!.requestKey);
  await expect(page.locator(".message-user")).toHaveCount(1);
});

for (const method of ["paste", "drop"] as const) {
  test(`adds clipboard or dragged image: ${method}`, async ({ page }) => {
    const chat = await setupChat(page);
    await openHome(page);
    await page.getByLabel("你的回答").evaluate(
      (el, { bytes, method }) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([Uint8Array.from(bytes)], "screen.png", {
            type: "image/png",
          }),
        );
        el.dispatchEvent(
          method === "paste"
            ? new ClipboardEvent("paste", {
                clipboardData: transfer,
                bubbles: true,
                cancelable: true,
              })
            : new DragEvent("drop", {
                dataTransfer: transfer,
                bubbles: true,
                cancelable: true,
              }),
        );
      },
      { bytes: [...PNG], method },
    );
    await expect.poll(() => chat.completions.length).toBe(1);
    await expect(page.getByLabel("待发送图片")).toBeVisible();
  });
}
test("desktop image icon opens upload and tablet offers camera", async ({
  page,
}) => {
  await setupChat(page);
  await openHome(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "添加图片", exact: true }).click();
  await (await chooser).setFiles([]);
  await expect(
    page.getByRole("button", { name: "拍照", exact: true }),
  ).toHaveCount(0);
  await page.emulateMedia({ media: "screen" });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 }),
  );
  await page.reload();
  await page.getByRole("button", { name: "添加图片", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "拍照", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "选择图片", exact: true }),
  ).toBeVisible();
});

test("keeps plus beside send when image capability is disabled", async ({
  page,
}) => {
  await setupChat(page);
  await page.route("**/api/capabilities", (route) =>
    reply(route, 200, {
      llmConfigured: true,
      uploadsConfigured: true,
      ocrConfigured: false,
      images: "disabled",
    }),
  );
  await openHome(page);
  const plus = page.getByRole("button", { name: "添加图片", exact: true });
  await expect(plus).toBeVisible();
  const a = await plus.boundingBox();
  const b = await page.getByRole("button", { name: "发送消息" }).boundingBox();
  expect(b!.x - (a!.x + a!.width)).toBeLessThan(20);
  expect(b!.x).toBeGreaterThan(a!.x);
  await plus.click();
  await expect(page.getByRole("alert")).toContainText(
    "当前模型尚未启用图片输入",
  );
});
