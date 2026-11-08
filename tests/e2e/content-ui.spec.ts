import { test, expect } from "@playwright/test";
import { mockLearningApi, revisionId } from "./fixtures/ui-api";
async function login(page: import("@playwright/test").Page) {
  await page.getByLabel("账号", { exact: true }).fill("student");
  await page.getByLabel("密码", { exact: true }).fill("long-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
}
test("explains missing storage without pretending an upload succeeded", async ({
  page,
}) => {
  await mockLearningApi(page);
  await page.route("**/api/materials*", (route) => route.fulfill({ json: [] }));
  await page.goto("/materials");
  await login(page);
  await expect(
    page.getByRole("heading", { name: "学习资料", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("文件存储尚未启用")).toBeVisible();
});
test("confirms selected recognition while keeping teacher annotations separate", async ({
  page,
}) => {
  await mockLearningApi(page);
  let confirmed = false;
  let sent: unknown;
  const materialId = "50000000-0000-4000-8000-000000000001";
  await page.route("**/api/materials/**", async (route) => {
    if (route.request().method() === "POST") {
      sent = route.request().postDataJSON();
      confirmed = true;
      return route.fulfill({
        json: { questionVersionIds: ["60000000-0000-4000-8000-000000000001"] },
      });
    }
    return route.fulfill({
      json: {
        version: 1,
        status: confirmed ? "confirmed" : "review",
        fileId: materialId,
        revisionId,
        confirmedQuestionVersionIds: confirmed
          ? ["60000000-0000-4000-8000-000000000001"]
          : [],
        payload: {
          pages: [{ pdfPageIndex: 0, text: "试卷", status: "ready" }],
          questions: [
            {
              candidateId: "one",
              stem: "原识别题干",
              studentAnswer: "2",
              teacherAnnotation: "错误",
              sources: [{ pageIndex: 0, bbox: [0, 0, 1, 1] }],
            },
            {
              candidateId: "two",
              stem: "另一题",
              sources: [{ pageIndex: 0, bbox: [0, 0, 1, 1] }],
            },
          ],
        },
      },
    });
  });
  await page.goto(`/materials/${materialId}`);
  await login(page);
  await expect(
    page.getByRole("heading", { name: "确认识别结果" }),
  ).toBeVisible();
  await page.getByLabel("选择第1题").check();
  await page.getByLabel("第1题题干").fill("1/2+1/2=?");
  await page.getByRole("button", { name: "确认所选题目" }).click();
  await expect(page.getByText("已确认 1 道题")).toBeVisible();
  expect(sent).toMatchObject({
    questions: [
      { stem: "1/2+1/2=?", studentAnswer: "2", teacherAnnotation: "错误" },
    ],
  });
});
test("administrator checks a page and publishes a revision", async ({
  page,
}) => {
  await mockLearningApi(page, "admin");
  let status = "review";
  await page.route(`**/api/catalog/textbooks/${revisionId}**`, async (route) =>
    route.fulfill({
      json: route.request().url().includes("/pages")
        ? [
            {
              id: "page",
              pageIndex: 0,
              printedPageLabel: "12",
              text: "通分的方法",
              status: "ready",
              excluded: false,
            },
          ]
        : {
            id: revisionId,
            title: "五年级数学",
            edition: "人教版",
            grade: "五年级",
            subject: "数学",
            term: "下册",
            publicationYear: 2024,
            revisionNo: 1,
            fileId: revisionId,
            status,
          },
    }),
  );
  await page.route(
    `**/api/admin/textbooks/${revisionId}/publish`,
    async (route) => {
      status = "published";
      await route.fulfill({ json: { ok: true } });
    },
  );
  await page.goto(`/admin/textbooks/${revisionId}`);
  await login(page);
  await expect(page.getByLabel("本页提取内容")).toHaveValue("通分的方法");
  await page.getByRole("button", { name: "发布教材", exact: true }).click();
  await expect(page.getByRole("button", { name: "停用教材" })).toBeVisible();
});
test("student grants and revokes explicit access", async ({ page }) => {
  await mockLearningApi(page);
  let granted = false;
  await page.route("**/api/students/*/access", async (route) => {
    if (route.request().method() === "POST") granted = true;
    if (route.request().method() === "DELETE") granted = false;
    await route.fulfill({
      json:
        route.request().method() === "GET"
          ? [
              { userId: "owner", login: "student", permission: "owner" },
              ...(granted
                ? [
                    {
                      userId: "10000000-0000-4000-8000-000000000002",
                      login: "teacher",
                      permission: "viewer",
                    },
                  ]
                : []),
            ]
          : { ok: true },
    });
  });
  await page.goto("/profile");
  await login(page);
  await page.getByLabel("授权账号").fill("teacher");
  await page.getByRole("button", { name: "授予访问权" }).click();
  await expect(page.getByText("teacher · 已授权")).toBeVisible();
  await page.getByRole("button", { name: "撤销访问" }).click();
  await expect(page.getByText("teacher · 已授权")).toHaveCount(0);
});
test("opens original question source from mistake history", async ({
  page,
}) => {
  await mockLearningApi(page);
  const id = "70000000-0000-4000-8000-000000000001",
    versionId = "71000000-0000-4000-8000-000000000001";
  await page.route(`**/api/mistakes/${id}**`, (route) =>
    route.fulfill({
      json: route.request().url().includes("/history")
        ? []
        : {
            id,
            questionId: id,
            questionVersionId: versionId,
            stem: "1+1=?",
            status: "pending_correction",
            dueAt: null,
            version: 1,
            originalAttemptId: null,
          },
    }),
  );
  await page.route(`**/api/question-versions/${versionId}/sources**`, (route) =>
    route.fulfill({
      json: [{ fileId: id, pageIndex: 1, bbox: [0.1, 0.1, 0.8, 0.8] }],
    }),
  );
  await page.route(`**/api/files/${id}/download`, (route) =>
    route.fulfill({
      json: {
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZUkAAAAASUVORK5CYII=",
        contentType: "image/png",
      },
    }),
  );
  await page.goto(`/mistakes/${id}`);
  await login(page);
  await page.getByRole("button", { name: "查看原图 · 第2页" }).click();
  await expect(page.getByRole("dialog")).toContainText("原始资料 · 第2页");
  await expect(page.getByAltText("上传的原始题目资料")).toBeVisible();
});
test("explains the textbook page limit instead of only showing parsing failed", async ({
  page,
}) => {
  await mockLearningApi(page, "admin");
  await page.route(`**/api/catalog/textbooks/${revisionId}**`, (r) =>
    r.fulfill({
      json: r.request().url().includes("/pages")
        ? []
        : {
            id: revisionId,
            fileId: revisionId,
            title: "长教材",
            edition: "人教版",
            grade: "高一",
            subject: "数学",
            term: "下册",
            revisionNo: 1,
            status: "failed",
            parseErrorCode: "PDF_PAGE_LIMIT",
          },
    }),
  );
  await page.goto(`/admin/textbooks/${revisionId}`);
  await login(page);
  await expect(page.getByRole("alert")).toContainText("500页");
});
