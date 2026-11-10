import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { AuthService } from "../../apps/server/src/modules/auth/service.js";
import { UploadService } from "../../apps/server/src/modules/uploads/service.js";
import { MemoryFileStore } from "../helpers/files.js";
import { CatalogService } from "../../apps/server/src/modules/catalog/service.js";
async function fixture(db: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
  const auth = new AuthService(db);
  const admin = await auth.createAdmin("admin", "long-test-password");
  const store = new MemoryFileStore();
  const uploads = new UploadService(db, auth, store);
  const file = await uploads.create(admin, {
    purpose: "textbook",
    name: "数学.pdf",
    size: 100,
    contentType: "application/pdf",
  });
  store.put(file.key, {
    size: 100,
    contentType: "application/pdf",
    prefix: Buffer.from("%PDF-1.7"),
  });
  await uploads.complete(admin, file.fileId);
  return { admin, file, catalog: new CatalogService(db, auth, uploads) };
}
it("publishes only reviewed usable pages and preserves old revisions", async () =>
  withTestDb(async (db) => {
    const { admin, file, catalog } = await fixture(db);
    const revision = await catalog.createDraft(admin, {
      title: "五年级数学",
      edition: "人教版",
      grade: "五年级",
      subject: "数学",
      term: "下册",
      publicationYear: 2024,
      fileId: file.fileId,
    });
    await catalog.startProcessing(admin, revision.id);
    await catalog.saveParsedPage(revision.id, {
      pdfPageIndex: 0,
      text: "通分需要公分母",
      status: "ready",
    });
    await catalog.saveParsedPage(revision.id, {
      pdfPageIndex: 1,
      text: "",
      status: "needs_ocr",
    });
    await catalog.finishProcessing(revision.id);
    await expect(catalog.publish(admin, revision.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await catalog.reviewPage(admin, {
      revisionId: revision.id,
      pageIndex: 1,
      excluded: true,
    });
    await catalog.publish(admin, revision.id);
    expect(await catalog.listPublished({ subject: "数学" })).toHaveLength(1);
    await expect(
      catalog.reviewPage(admin, {
        revisionId: revision.id,
        pageIndex: 0,
        text: "替换原文",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await catalog.disable(admin, revision.id);
    expect(await catalog.listPublished({})).toHaveLength(0);
    expect((await catalog.getRevision(admin, revision.id)).status).toBe(
      "disabled",
    );
  }));
it("rejects non-admin publishing and deduplicates parsing requests", async () =>
  withTestDb(async (db) => {
    const { admin, file, catalog } = await fixture(db);
    const r = await catalog.createDraft(admin, {
      title: "数学",
      edition: "苏教版",
      grade: "五年级",
      subject: "数学",
      term: "上册",
      publicationYear: 2024,
      fileId: file.fileId,
    });
    await expect(
      catalog.publish({ userId: admin.userId, role: "student" }, r.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await catalog.startProcessing(admin, r.id);
    await catalog.startProcessing(admin, r.id);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM jobs WHERE kind='textbook.parse'",
        )
      ).rows[0].n,
    ).toBe(1);
  }));
it("allows review of textbook pages beyond the student paper page limit", async () =>
  withTestDb(async (db) => {
    const { admin, file, catalog } = await fixture(db);
    const r = await catalog.createDraft(admin, {
      title: "长教材",
      edition: "人教版",
      grade: "高一",
      subject: "数学",
      term: "下册",
      publicationYear: 2024,
      fileId: file.fileId,
    });
    await catalog.startProcessing(admin, r.id);
    await catalog.saveParsedPage(r.id, {
      pdfPageIndex: 281,
      text: "教材末页",
      status: "ready",
    });
    await catalog.finishProcessing(r.id);
    await catalog.reviewPage(admin, {
      revisionId: r.id,
      pageIndex: 281,
      printedPageLabel: "282",
      text: "人工核对末页",
    });
    expect((await catalog.getPages(admin, r.id)).at(-1)?.text).toBe(
      "人工核对末页",
    );
  }));
it("automatically excludes successful empty pages without hiding OCR failures", async () =>
  withTestDb(async (db) => {
    const { admin, file, catalog } = await fixture(db);
    const r = await catalog.createDraft(admin, {
      title: "自动排除",
      edition: "人教版",
      grade: "高一",
      subject: "数学",
      term: "下册",
      publicationYear: 2024,
      fileId: file.fileId,
    });
    await catalog.startProcessing(admin, r.id);
    for (const [pdfPageIndex, text, status] of [
      [0, "有效教材文字", "ready"],
      [1, " \n\t　", "ready"],
      [2, "", "needs_ocr"],
    ] as const)
      await catalog.saveParsedPage(r.id, { pdfPageIndex, text, status });
    await catalog.finishProcessing(r.id);
    const pages = await catalog.getPages(admin, r.id);
    expect(pages[1]?.excluded).toBe(true);
    expect(pages[2]?.excluded).toBe(false);
    await expect(catalog.publish(admin, r.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await catalog.reviewPage(admin, {
      revisionId: r.id,
      pageIndex: 2,
      excluded: true,
    });
    await catalog.publish(admin, r.id);
    expect((await catalog.getRevision(admin, r.id)).status).toBe("published");
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM audit_events WHERE action='textbook.auto_exclude_empty'",
        )
      ).rows[0].n,
    ).toBe(1);
  }));
it("handles existing review drafts automatically at publication and keeps empty books unpublished", async () =>
  withTestDb(async (db) => {
    const { admin, file, catalog } = await fixture(db);
    const r = await catalog.createDraft(admin, {
      title: "旧草稿",
      edition: "人教版",
      grade: "高一",
      subject: "数学",
      term: "下册",
      publicationYear: 2024,
      fileId: file.fileId,
    });
    await catalog.startProcessing(admin, r.id);
    await catalog.saveParsedPage(r.id, {
      pdfPageIndex: 0,
      text: "教学正文",
      status: "ready",
    });
    await catalog.saveParsedPage(r.id, {
      pdfPageIndex: 1,
      text: "",
      status: "ready",
    });
    await catalog.finishProcessing(r.id);
    await db.pool.query(
      "UPDATE textbook_pages SET excluded=false WHERE revision_id=$1",
      [r.id],
    );
    await catalog.publish(admin, r.id);
    expect((await catalog.getPages(admin, r.id))[1]?.excluded).toBe(true);
    const empty = await catalog.createDraft(admin, {
      title: "全空",
      edition: "苏教版",
      grade: "高一",
      subject: "数学",
      term: "下册",
      publicationYear: 2024,
      fileId: file.fileId,
    });
    await catalog.startProcessing(admin, empty.id);
    await catalog.saveParsedPage(empty.id, {
      pdfPageIndex: 0,
      text: "",
      status: "ready",
    });
    await catalog.finishProcessing(empty.id);
    await expect(catalog.publish(admin, empty.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  }));
