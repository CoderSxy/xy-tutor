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
