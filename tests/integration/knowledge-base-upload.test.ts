import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { AuthService } from "../../apps/server/src/modules/auth/service.js";
import { UploadService } from "../../apps/server/src/modules/uploads/service.js";
import { MemoryFileStore } from "../helpers/files.js";
import { buildApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import type { ModelGateway } from "../../apps/server/src/agent/provider.js";
import { sessionCookie } from "../helpers/student-insights.js";
import type { Database } from "../../packages/db/src/client.js";
import type { Actor } from "../../packages/contracts/src/domain.js";

const password = "test-password-long";
const config = loadConfig({ NODE_ENV: "test" });

async function fixture(db: Database) {
  const auth = new AuthService(db);
  const admin = await auth.createAdmin("admin", password);
  const invitation = await auth.invite(admin, { login: "student" });
  const student = await auth.activate({
    token: invitation.activationToken,
    password,
  });
  const adminToken = (await auth.login({ login: "admin", password }))
    .sessionToken;
  const studentToken = (await auth.login({ login: "student", password }))
    .sessionToken;
  const store = new MemoryFileStore();
  const uploads = new UploadService(db, auth, store);
  const readyFile = async (
    actor: Actor,
    input: {
      purpose: "knowledge_source" | "textbook";
      name: string;
      contentType: string;
      prefix: string;
    },
  ) => {
    const grant = await uploads.create(actor, {
      purpose: input.purpose,
      name: input.name,
      contentType: input.contentType,
      size: input.prefix.length,
    });
    store.put(grant.key, {
      size: input.prefix.length,
      contentType: input.contentType,
      prefix: Buffer.from(input.prefix),
    });
    await uploads.complete(actor, grant.fileId);
    return grant.fileId;
  };
  return {
    auth,
    admin,
    student,
    adminToken,
    studentToken,
    store,
    uploads,
    readyFile,
  };
}

function build(
  db: Database,
  store: MemoryFileStore,
  options: { modelConfigured?: boolean } = {},
) {
  return buildApp({
    database: db,
    config,
    fileStore: store,
    gateway: options.modelConfigured
      ? ({} as unknown as ModelGateway)
      : undefined,
  });
}

it("keeps admin knowledge batch endpoints behind session and admin checks", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const app = build(db, f.store);
    try {
      for (const [method, url] of [
        ["POST", "/api/admin/knowledge/batches"],
        ["GET", "/api/admin/knowledge/batches"],
        [
          "GET",
          `/api/admin/knowledge/batches/${randomUUID()}`,
        ],
      ] as const) {
        const anonymous = await app.inject({
          method,
          url,
          ...(method === "POST" ? { headers: { origin: config.origin } } : {}),
        });
        expect(anonymous.statusCode).toBe(401);
        const asStudent = await app.inject({
          method,
          url,
          headers: { ...sessionCookie(f.studentToken), origin: config.origin },
          ...(method === "POST" ? { payload: { text: "函数" } } : {}),
        });
        expect(asStudent.statusCode).toBe(403);
      }
    } finally {
      await app.close();
    }
  }));

it("rejects empty and invalid knowledge batches", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const app = build(db, f.store);
    const headers = { ...sessionCookie(f.adminToken), origin: config.origin };
    try {
      const empty = await app.inject({
        method: "POST",
        url: "/api/admin/knowledge/batches",
        headers,
        payload: {},
      });
      expect(empty.statusCode).toBe(422);

      const textbookFileId = await f.readyFile(f.admin, {
        purpose: "textbook",
        name: "教材.pdf",
        contentType: "application/pdf",
        prefix: "%PDF-1.7",
      });
      const wrongPurpose = await app.inject({
        method: "POST",
        url: "/api/admin/knowledge/batches",
        headers,
        payload: { fileIds: [textbookFileId] },
      });
      expect(wrongPurpose.statusCode).toBe(409);

      const pending = await f.uploads.create(f.admin, {
        purpose: "knowledge_source",
        name: "待完成.pdf",
        contentType: "application/pdf",
        size: 7,
      });
      const notReady = await app.inject({
        method: "POST",
        url: "/api/admin/knowledge/batches",
        headers,
        payload: { fileIds: [pending.fileId] },
      });
      expect(notReady.statusCode).toBe(409);

      const odd = (
        await db.pool.query(
          "INSERT INTO files(owner_id,purpose,name,content_type,size,object_key,status) VALUES($1,'knowledge_source','页面.html','text/html',10,$2,'ready') RETURNING id",
          [f.admin.userId, `knowledge_source/${randomUUID()}`],
        )
      ).rows[0];
      const badType = await app.inject({
        method: "POST",
        url: "/api/admin/knowledge/batches",
        headers,
        payload: { fileIds: [odd.id] },
      });
      expect(badType.statusCode).toBe(422);

      expect(
        (await db.pool.query("SELECT count(*)::int AS n FROM knowledge_batches"))
          .rows[0].n,
      ).toBe(0);
    } finally {
      await app.close();
    }
  }));

it("queues a parse run for an accepted admin batch", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const app = build(db, f.store, { modelConfigured: true });
    const headers = { ...sessionCookie(f.adminToken), origin: config.origin };
    try {
      const fileId = await f.readyFile(f.admin, {
        purpose: "knowledge_source",
        name: "一元一次方程.md",
        contentType: "text/markdown",
        prefix: "# 一元一次方程\n移项",
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/admin/knowledge/batches",
        headers,
        payload: {
          text: "分数加减法",
          fileIds: [fileId],
          extraPrompt: "按教材章节拆分",
        },
      });
      expect(created.statusCode).toBe(200);
      const batch = created.json();
      expect(batch.textContent).toBe("分数加减法");
      expect(batch.files).toEqual([
        {
          fileId,
          name: "一元一次方程.md",
          contentType: "text/markdown",
        },
      ]);
      expect(batch.latestRun).toMatchObject({
        batchId: batch.id,
        extraPrompt: "按教材章节拆分",
        status: "queued",
        itemCount: 0,
      });
      expect(batch.pendingCount).toBe(0);
      expect(batch.publishedCount).toBe(0);

      const job = (
        await db.pool.query("SELECT kind,dedupe_key,payload FROM jobs")
      ).rows[0];
      expect(job.kind).toBe("knowledge.parse");
      expect(job.dedupe_key).toBe(`knowledge.parse:${batch.latestRun.id}`);
      expect(job.payload).toEqual({ runId: batch.latestRun.id });

      const fetched = await app.inject({
        method: "GET",
        url: `/api/admin/knowledge/batches/${batch.id}`,
        headers,
      });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json().latestRun.id).toBe(batch.latestRun.id);

      const listed = await app.inject({
        method: "GET",
        url: "/api/admin/knowledge/batches",
        headers,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({ total: 1 });
      expect(listed.json().items).toHaveLength(1);

      const audit = await db.pool.query(
        "SELECT action FROM audit_events WHERE action='knowledge.batch.create'",
      );
      expect(audit.rowCount).toBe(1);
    } finally {
      await app.close();
    }
  }));

it("records a failed run when the model is not configured", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const app = build(db, f.store);
    const headers = { ...sessionCookie(f.adminToken), origin: config.origin };
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/admin/knowledge/batches",
        headers,
        payload: { text: "只输入文本也能创建批次" },
      });
      expect(created.statusCode).toBe(200);
      const batch = created.json();
      expect(batch.latestRun).toMatchObject({
        status: "failed",
        errorCode: "MODEL_NOT_CONFIGURED",
        itemCount: 0,
      });
      expect(
        (await db.pool.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n,
      ).toBe(0);
      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int AS n FROM knowledge_items",
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await app.close();
    }
  }));
