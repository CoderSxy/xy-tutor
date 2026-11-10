import { createCanvas } from "@napi-rs/canvas";
import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { AuthService } from "../../apps/server/src/modules/auth/service.js";
import { UploadService } from "../../apps/server/src/modules/uploads/service.js";
import { MemoryFileStore } from "../helpers/files.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
const password = "test-password-long";
it("keeps uploads private even from administrators and deduplicates completion", async () =>
  withTestDb(async (db) => {
    const auth = new AuthService(db);
    const admin = await auth.createAdmin("admin", password);
    const inv = await auth.invite(admin, { login: "student" });
    const st = await auth.activate({ token: inv.activationToken, password });
    const actor = { userId: st.userId, role: "student" as const };
    const store = new MemoryFileStore();
    const service = new UploadService(db, auth, store);
    const grant = await service.create(actor, {
      studentId: st.studentId,
      purpose: "student_material",
      name: "试卷.pdf",
      contentType: "application/pdf",
      size: 100,
    });
    store.put(grant.key, {
      size: 100,
      contentType: "application/pdf",
      prefix: Buffer.from("%PDF-1.7"),
    });
    await service.complete(actor, grant.fileId);
    await service.complete(actor, grant.fileId);
    expect((await service.getDownload(actor, grant.fileId)).url).toContain(
      "download",
    );
    await expect(
      service.getDownload(admin, grant.fileId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM files")).rows[0].n,
    ).toBe(1);
  }));
it("rejects fake MIME, oversize files and foreign object keys", async () =>
  withTestDb(async (db) => {
    const auth = new AuthService(db);
    const admin = await auth.createAdmin("admin", password);
    const store = new MemoryFileStore();
    const s = new UploadService(db, auth, store);
    await expect(
      s.create(admin, {
        purpose: "textbook",
        name: "large.pdf",
        size: 50 * 1024 * 1024,
        contentType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      s.create(admin, {
        purpose: "textbook",
        name: "x.pdf",
        size: 10,
        contentType: "application/pdf",
        key: "someone-else",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const grant = await s.create(admin, {
      purpose: "textbook",
      name: "fake.pdf",
      size: 10,
      contentType: "application/pdf",
    });
    store.put(grant.key, {
      size: 10,
      contentType: "application/pdf",
      prefix: Buffer.from("<html>"),
    });
    await expect(s.complete(admin, grant.fileId)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(
      (
        await db.pool.query("SELECT status FROM files WHERE id=$1", [
          grant.fileId,
        ])
      ).rows[0].status,
    ).toBe("rejected");
  }));
it("reports missing OSS explicitly", async () =>
  withTestDb(async (db) => {
    const auth = new AuthService(db);
    const admin = await auth.createAdmin("admin", password);
    const s = new UploadService(db, auth);
    await expect(
      s.create(admin, {
        purpose: "textbook",
        name: "x.pdf",
        size: 10,
        contentType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  }));
it("seals completed originals against reuse of a live upload URL", async () =>
  withTestDb(async (db) => {
    const auth = new AuthService(db);
    const admin = await auth.createAdmin("admin", password);
    const store = new MemoryFileStore();
    const s = new UploadService(db, auth, store);
    const g = await s.create(admin, {
      purpose: "textbook",
      name: "original.pdf",
      size: 100,
      contentType: "application/pdf",
    });
    store.put(g.key, {
      size: 100,
      contentType: "application/pdf",
      prefix: Buffer.from("%PDF-1.7 original"),
    });
    await s.complete(admin, g.fileId);
    store.put(g.key, {
      size: 100,
      contentType: "application/pdf",
      prefix: Buffer.from("%PDF-1.7 replaced"),
    });
    const file = await s.authorize(admin, g.fileId);
    expect((await store.head(file.object_key)).prefix.toString()).toBe(
      "%PDF-1.7 original",
    );
  }));
it("accepts conversation images only from the owning student and records their size", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: revision.id,
      kind: "free_question",
    });
    const canvas = createCanvas(640, 480);
    const bytes = canvas.toBuffer("image/png");
    const input = {
      studentId: f.scope.studentId,
      purpose: "conversation_image" as const,
      conversationId: task.conversationId,
      name: "answer.png",
      contentType: "image/png" as const,
      size: bytes.length,
    };
    await expect(
      f.uploads.create(f.scope.actor, {
        ...input,
        purpose: "conversation_image",
        contentType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      f.uploads.create(f.scope.actor, {
        ...input,
        conversationId: undefined,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      f.uploads.create(f.scope.actor, {
        ...input,
        size: 15 * 1024 ** 2 + 1,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const invitation = await f.auth.invite(f.admin, { login: "stranger" });
    const stranger = await f.auth.activate({
      token: invitation.activationToken,
      password,
    });
    await expect(
      f.uploads.create(
        { userId: stranger.userId, role: "student" },
        { ...input, studentId: stranger.studentId },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const grant = await f.uploads.create(f.scope.actor, input);
    f.store.put(grant.key, {
      size: bytes.length,
      contentType: "image/png",
      prefix: bytes,
    });
    await f.uploads.complete(f.scope.actor, grant.fileId);
    const file = (
      await db.pool.query(
        "SELECT status,width,height,conversation_id FROM files WHERE id=$1",
        [grant.fileId],
      )
    ).rows[0];
    expect(file).toMatchObject({
      status: "ready",
      width: 640,
      height: 480,
      conversation_id: task.conversationId,
    });
    expect(await f.uploads.getDownload(f.scope.actor, grant.fileId)).toMatchObject({
      contentType: "image/png",
      expiresAt: expect.any(String),
    });
  }));
it("accepts textbook PDFs below 50MiB but rejects 50MiB and keeps student PDFs at 30MiB", async () =>
  withTestDb(async (db) => {
    const auth = new AuthService(db);
    const admin = await auth.createAdmin("size-admin", password);
    const inv = await auth.invite(admin, { login: "size-student" });
    const student = await auth.activate({
      token: inv.activationToken,
      password,
    });
    const service = new UploadService(db, auth, new MemoryFileStore());
    const grant = await service.create(admin, {
      purpose: "textbook",
      name: "book.pdf",
      size: 50 * 1024 ** 2 - 1,
      contentType: "application/pdf",
    });
    expect(grant.fileId).toBeTruthy();
    await expect(
      service.create(admin, {
        purpose: "textbook",
        name: "limit.pdf",
        size: 50 * 1024 ** 2,
        contentType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      service.create(
        { userId: student.userId, role: "student" },
        {
          studentId: student.studentId,
          purpose: "student_material",
          name: "paper.pdf",
          size: 31 * 1024 ** 2,
          contentType: "application/pdf",
        },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  }));
