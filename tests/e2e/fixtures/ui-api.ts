import type { Page } from "@playwright/test";
export const studentId = "10000000-0000-4000-8000-000000000001";
export const revisionId = "20000000-0000-4000-8000-000000000001";
export const taskId = "30000000-0000-4000-8000-000000000001";
export const conversationId = "40000000-0000-4000-8000-000000000001";
export const runId = "60000000-0000-4000-8000-000000000001";
export const retryRunId = "60000000-0000-4000-8000-000000000002";
export const practiceSetId = "50000000-0000-4000-8000-000000000001";
export const continuedTaskId = "30000000-0000-4000-8000-000000000099";
export const continuedSetId = "50000000-0000-4000-8000-000000000099";

function pad(n: number) {
  return String(n).padStart(12, "0");
}
function itemId(n: number) {
  return `51000000-0000-4000-8000-${pad(n)}`;
}
function slotId(n: number) {
  return `52000000-0000-4000-8000-${pad(n)}`;
}
function questionVersionId(n: number) {
  return `53000000-0000-4000-8000-${pad(n)}`;
}

function unanswered(n: number) {
  return {
    itemId: itemId(n),
    submission: "unanswered",
    grading: "none",
    correctness: null,
    mistakeSync: "not_required",
  };
}

export function samplePracticeItems() {
  return [
    {
      slotId: slotId(1),
      position: 0,
      questionType: "single_choice",
      itemId: itemId(1),
      questionVersionId: questionVersionId(1),
      stem: "计算 $1+1$ 的值。",
      presentation: {
        kind: "choice",
        multiple: false,
        options: [
          { optionId: "opt-a", label: "1" },
          { optionId: "opt-b", label: "2" },
        ],
      },
      progress: unanswered(1),
      reasonCode: null,
    },
    {
      slotId: slotId(2),
      position: 1,
      questionType: "single_choice",
      itemId: itemId(2),
      questionVersionId: questionVersionId(2),
      stem: "计算 $2+2$ 的值。",
      presentation: {
        kind: "choice",
        multiple: false,
        options: [
          { optionId: "opt-c", label: "3" },
          { optionId: "opt-d", label: "4" },
        ],
      },
      progress: unanswered(2),
      reasonCode: null,
    },
    {
      slotId: slotId(3),
      position: 2,
      questionType: "fill_blank",
      itemId: itemId(3),
      questionVersionId: questionVersionId(3),
      stem: "填空：$3+3=$ ____。",
      presentation: {
        kind: "blank",
        blanks: [{ blankId: "b1", label: "结果", placeholder: "填写答案" }],
      },
      progress: unanswered(3),
      reasonCode: null,
    },
    {
      slotId: slotId(4),
      position: 3,
      questionType: "fill_blank",
      itemId: itemId(4),
      questionVersionId: questionVersionId(4),
      stem: "填空：$4+4=$ ____。",
      presentation: {
        kind: "blank",
        blanks: [{ blankId: "b2", label: "结果", placeholder: "填写答案" }],
      },
      progress: unanswered(4),
      reasonCode: null,
    },
    {
      slotId: slotId(5),
      position: 4,
      questionType: "worked",
      itemId: itemId(5),
      questionVersionId: questionVersionId(5),
      stem: "写出计算 $5+5$ 的过程。",
      presentation: {
        kind: "worked",
        requirements: "写出关键步骤",
        requiresWorking: true,
      },
      progress: unanswered(5),
      reasonCode: null,
    },
  ];
}

export async function mockLearningApi(
  page: Page,
  role: "student" | "admin" = "student",
  options: { practiceSets?: boolean } = {},
) {
  let signedIn = false;
  let tasks: unknown[] = [];
  let selections: unknown[] = [];
  let practiceSet: Record<string, unknown> | null = null;
  const drafts = new Map<
    string,
    { itemId: string; answer: unknown; version: number; updatedAt: string }
  >();
  let draftConflict = false;
  const submissions: unknown[] = [];
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
        ...(options.practiceSets
          ? { practiceSets: "enabled", mobileStudy: "disabled" }
          : {}),
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
    else if (path === "/api/practice-preferences")
      body = {
        version: 1,
        mode: null,
        strategy: "mixed",
        examProfileId: null,
      };
    else if (
      path === `/api/tasks/${taskId}/practice-set` &&
      request.method() === "GET"
    ) {
      if (!practiceSet) {
        status = 404;
        body = { error: { code: "NOT_FOUND", message: "题组不存在" } };
      } else body = practiceSet;
    } else if (
      path === `/api/tasks/${taskId}/practice-set` &&
      request.method() === "POST"
    ) {
      const input = (request.postDataJSON() as {
        mode?: string;
        strategy?: string;
      }) ?? {};
      practiceSet = {
        id: practiceSetId,
        taskId,
        version: 1,
        mode: input.mode === "batch" ? "batch" : "step",
        strategy: input.strategy === "exam" ? "exam" : "mixed",
        examProfileId: null,
        generation: "ready",
        submission: "open",
        counts: {
          total: 5,
          submitted: 0,
          skipped: 0,
          verified: 0,
          pending: 0,
        },
        canContinue: false,
        items: samplePracticeItems(),
      };
      body = practiceSet;
    } else if (
      path === `/api/practice-sets/${practiceSetId}` &&
      request.method() === "PATCH"
    ) {
      const input = (request.postDataJSON() as { mode?: string }) ?? {};
      if (practiceSet)
        practiceSet = {
          ...practiceSet,
          mode: input.mode === "batch" ? "batch" : "step",
          version: Number(practiceSet.version) + 1,
        };
      body = practiceSet;
    } else if (path === `/api/practice-sets/${practiceSetId}/drafts`) {
      body = [...drafts.values()];
    } else if (
      path.startsWith(`/api/practice-sets/${practiceSetId}/drafts/`) &&
      request.method() === "PUT"
    ) {
      const draftItemId = path.split("/").at(-1)!;
      const input = (request.postDataJSON() as {
        expectedVersion?: number;
        answer?: unknown;
      }) ?? {};
      const existing = drafts.get(draftItemId);
      if (draftConflict && existing) {
        status = 409;
        body = { error: { code: "CONFLICT", message: "草稿已更新，请刷新后重试" } };
      } else if (existing && existing.version !== input.expectedVersion) {
        status = 409;
        body = { error: { code: "CONFLICT", message: "草稿已更新，请刷新后重试" } };
      } else {
        const version = existing ? existing.version + 1 : 1;
        const saved = {
          itemId: draftItemId,
          answer: input.answer,
          version,
          updatedAt: new Date().toISOString(),
        };
        drafts.set(draftItemId, saved);
        body = saved;
      }
    } else if (
      path === `/api/practice-sets/${practiceSetId}/submit` &&
      request.method() === "POST"
    ) {
      const input = (request.postDataJSON() as {
        entries?: { itemId: string }[];
        skippedItemIds?: string[];
      }) ?? {};
      submissions.push(input);
      const submittedIds = new Set([
        ...(input.entries ?? []).map((entry) => entry.itemId),
        ...(input.skippedItemIds ?? []),
      ]);
      if (practiceSet) {
        const items = (
          practiceSet.items as Array<{
            itemId: string | null;
            progress: Record<string, unknown>;
          }>
        ).map((item) => {
          if (!item.itemId || !submittedIds.has(item.itemId)) return item;
          const skipped = input.skippedItemIds?.includes(item.itemId);
          return {
            ...item,
            progress: {
              ...item.progress,
              submission: skipped ? "skipped" : "submitted",
              grading: skipped ? "none" : "queued",
            },
          };
        });
        const submittedCount = items.filter(
          (item) => item.progress.submission === "submitted",
        ).length;
        const skippedCount = items.filter(
          (item) => item.progress.submission === "skipped",
        ).length;
        practiceSet = {
          ...practiceSet,
          version: Number(practiceSet.version) + 1,
          items,
          counts: {
            total: 5,
            submitted: submittedCount,
            skipped: skippedCount,
            verified: 0,
            pending: 0,
          },
          canContinue: false,
          submission: "grading",
        };
      }
      body = {
        id: "54000000-0000-4000-8000-000000000001",
        setId: practiceSetId,
        state: "grading",
        items:
          (practiceSet?.items as Array<{ progress: unknown }>)?.map(
            (item) => item.progress,
          ) ?? [],
      };
      status = 202;
    } else if (
      path === `/api/practice-sets/${practiceSetId}/continue` &&
      request.method() === "POST"
    ) {
      body = {
        taskId: continuedTaskId,
        setId: continuedSetId,
        conversationId,
      };
    } else {
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
