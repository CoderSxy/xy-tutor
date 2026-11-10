import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { AuthService } from "../../apps/server/src/modules/auth/service.js";
import { buildApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import type { ModelGateway } from "../../apps/server/src/agent/provider.js";
import { sessionCookie } from "../helpers/student-insights.js";
import type { Database } from "../../packages/db/src/client.js";

const password = "test-password-long";
const config = loadConfig({ NODE_ENV: "test" });

async function fixture(db: Database) {
  const auth = new AuthService(db);
  const admin = await auth.createAdmin("admin", password);
  const invitation = await auth.invite(admin, { login: "student" });
  await auth.activate({ token: invitation.activationToken, password });
  const adminToken = (await auth.login({ login: "admin", password }))
    .sessionToken;
  const studentToken = (await auth.login({ login: "student", password }))
    .sessionToken;
  const source = async () => {
    const batch = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO knowledge_batches(actor_id,text_content) VALUES($1,'分数加减法') RETURNING id",
        [admin.userId],
      )
    ).rows[0]!;
    const run = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO knowledge_parse_runs(batch_id,status,model,completed_at) VALUES($1,'succeeded','fake',now()) RETURNING id",
        [batch.id],
      )
    ).rows[0]!;
    return { batchId: batch.id, runId: run.id };
  };
  const item = async (input: {
    batchId: string;
    runId: string;
    title: string;
    summary: string;
    status?: string;
    replacesItemId?: string | null;
  }) =>
    (
      await db.pool.query<{ id: string }>(
        "INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status,replaces_item_id,published_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [
          input.batchId,
          input.runId,
          input.title,
          input.summary,
          input.status ?? "pending_review",
          input.replacesItemId ?? null,
          input.status === "published" ? new Date() : null,
        ],
      )
    ).rows[0]!.id;
  return { auth, admin, adminToken, studentToken, source, item };
}

function build(db: Database, modelConfigured = true) {
  return buildApp({
    database: db,
    config,
    gateway: modelConfigured
      ? ({} as unknown as ModelGateway)
      : undefined,
  });
}

it("keeps knowledge review endpoints admin-only", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const app = build(db);
    const id = randomUUID();
    const calls = [
      { method: "GET", url: "/api/admin/knowledge/items" },
      {
        method: "PATCH",
        url: `/api/admin/knowledge/items/${id}`,
        payload: { title: "标题", summary: "总结" },
      },
      {
        method: "POST",
        url: "/api/admin/knowledge/items/discard",
        payload: { ids: [id] },
      },
      {
        method: "POST",
        url: "/api/admin/knowledge/items/publish",
        payload: { ids: [id] },
      },
      {
        method: "POST",
        url: `/api/admin/knowledge/batches/${id}/reparse`,
        payload: { extraPrompt: "按步骤拆" },
      },
      {
        method: "POST",
        url: `/api/admin/knowledge/items/${id}/reparse`,
        payload: { extraPrompt: "按步骤拆" },
      },
    ] as const;
    try {
      for (const call of calls) {
        const anonymous = await app.inject({
          method: call.method,
          url: call.url,
          headers: { origin: config.origin },
          ...("payload" in call ? { payload: call.payload } : {}),
        });
        expect(anonymous.statusCode).toBe(401);
        const asStudent = await app.inject({
          method: call.method,
          url: call.url,
          headers: { ...sessionCookie(f.studentToken), origin: config.origin },
          ...("payload" in call ? { payload: call.payload } : {}),
        });
        expect(asStudent.statusCode).toBe(403);
      }
    } finally {
      await app.close();
    }
  }));

it("publishes pending items and lists them by status", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const { batchId, runId } = await f.source();
    const first = await f.item({
      batchId,
      runId,
      title: "通分",
      summary: "异分母分数化为同分母分数",
    });
    const second = await f.item({
      batchId,
      runId,
      title: "约分",
      summary: "分子分母同除公因数",
    });
    const app = build(db);
    const headers = { ...sessionCookie(f.adminToken), origin: config.origin };
    try {
      const published = await app.inject({
        method: "POST",
        url: "/api/admin/knowledge/items/publish",
        headers,
        payload: { ids: [first] },
      });
      expect(published.statusCode).toBe(200);
      expect(published.json()).toHaveLength(1);
      expect(published.json()[0]).toMatchObject({
        id: first,
        status: "published",
        title: "通分",
      });
      expect(published.json()[0].publishedAt).toEqual(expect.any(String));

      const row = (
        await db.pool.query(
          "SELECT status,published_at FROM knowledge_items WHERE id=$1",
          [first],
        )
      ).rows[0];
      expect(row.status).toBe("published");
      expect(row.published_at).toBeInstanceOf(Date);

      const all = await app.inject({
        method: "GET",
        url: "/api/admin/knowledge/items",
        headers,
      });
      expect(all.statusCode).toBe(200);
      expect(all.json()).toMatchObject({ total: 2 });
      expect(
        all.json().items.map((item: { id: string }) => item.id).sort(),
      ).toEqual([first, second].sort());

      const pending = await app.inject({
        method: "GET",
        url: "/api/admin/knowledge/items?status=pending_review",
        headers,
      });
      expect(pending.json()).toMatchObject({ total: 1 });
      expect(pending.json().items[0].id).toBe(second);

      const searched = await app.inject({
        method: "GET",
        url: `/api/admin/knowledge/items?q=${encodeURIComponent("异分母")}`,
        headers,
      });
      expect(searched.json()).toMatchObject({ total: 1 });
      expect(searched.json().items[0].id).toBe(first);
    } finally {
      await app.close();
    }
  }));

it("edits pending or published items but not discarded ones", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const { batchId, runId } = await f.source();
    const pending = await f.item({
      batchId,
      runId,
      title: "待确认",
      summary: "旧总结",
    });
    const published = await f.item({
      batchId,
      runId,
      title: "已发布",
      summary: "旧总结",
      status: "published",
    });
    const discarded = await f.item({
      batchId,
      runId,
      title: "已丢弃",
      summary: "旧总结",
      status: "discarded",
    });
    const app = build(db);
    const headers = { ...sessionCookie(f.adminToken), origin: config.origin };
    try {
      const editPending = await app.inject({
        method: "PATCH",
        url: `/api/admin/knowledge/items/${pending}`,
        headers,
        payload: { title: "新标题", summary: "新总结" },
      });
      expect(editPending.statusCode).toBe(200);
      expect(editPending.json()).toMatchObject({
        title: "新标题",
        summary: "新总结",
        status: "pending_review",
      });

      const editPublished = await app.inject({
        method: "PATCH",
        url: `/api/admin/knowledge/items/${published}`,
        headers,
        payload: { title: "已发布", summary: "更新后的总结" },
      });
      expect(editPublished.statusCode).toBe(200);
      expect(
        (
          await db.pool.query(
            "SELECT summary FROM knowledge_items WHERE id=$1",
            [published],
          )
        ).rows[0].summary,
      ).toBe("更新后的总结");

      const editDiscarded = await app.inject({
        method: "PATCH",
        url: `/api/admin/knowledge/items/${discarded}`,
        headers,
        payload: { title: "改不了", summary: "改不了" },
      });
      expect(editDiscarded.statusCode).toBe(409);

      const audit = await db.pool.query(
        "SELECT details FROM audit_events WHERE action='knowledge.item.update'",
      );
      expect(audit.rowCount).toBe(2);
      for (const row of audit.rows)
        expect(JSON.stringify(row.details)).not.toContain("更新后的总结");
    } finally {
      await app.close();
    }
  }));

it("discards pending items and refuses to publish them", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const { batchId, runId } = await f.source();
    const kept = await f.item({
      batchId,
      runId,
      title: "保留",
      summary: "保留的总结",
    });
    const dropped = await f.item({
      batchId,
      runId,
      title: "丢弃",
      summary: "丢弃的总结",
    });
    const app = build(db);
    const headers = { ...sessionCookie(f.adminToken), origin: config.origin };
    try {
      const discarded = await app.inject({
        method: "POST",
        url: "/api/admin/knowledge/items/discard",
        headers,
        payload: { ids: [dropped] },
      });
      expect(discarded.statusCode).toBe(200);
      expect(
        (
          await db.pool.query(
            "SELECT status FROM knowledge_items WHERE id=$1",
            [dropped],
          )
        ).rows[0].status,
      ).toBe("discarded");

      const publish = await app.inject({
        method: "POST",
        url: "/api/admin/knowledge/items/publish",
        headers,
        payload: { ids: [dropped] },
      });
      expect(publish.statusCode).toBe(409);
      expect(
        (
          await db.pool.query(
            "SELECT status FROM knowledge_items WHERE id=$1",
            [dropped],
          )
        ).rows[0].status,
      ).toBe("discarded");

      const publishKept = await app.inject({
        method: "POST",
        url: "/api/admin/knowledge/items/publish",
        headers,
        payload: { ids: [kept] },
      });
      expect(publishKept.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }));

it("reparses a batch into a new run without touching published items", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const { batchId, runId } = await f.source();
    const published = await f.item({
      batchId,
      runId,
      title: "已发布",
      summary: "发布时的总结",
      status: "published",
    });
    const app = build(db);
    const headers = { ...sessionCookie(f.adminToken), origin: config.origin };
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/admin/knowledge/batches/${batchId}/reparse`,
        headers,
        payload: { extraPrompt: "按例题拆分" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        batchId,
        extraPrompt: "按例题拆分",
        status: "queued",
        itemCount: 0,
      });

      const jobs = (
        await db.pool.query("SELECT kind,payload FROM jobs ORDER BY created_at")
      ).rows;
      expect(jobs).toHaveLength(1);
      expect(jobs[0].kind).toBe("knowledge.parse");
      expect(jobs[0].payload).toEqual({ runId: response.json().id });

      const row = (
        await db.pool.query(
          "SELECT title,summary,status FROM knowledge_items WHERE id=$1",
          [published],
        )
      ).rows[0];
      expect(row).toMatchObject({
        title: "已发布",
        summary: "发布时的总结",
        status: "published",
      });

      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int AS n FROM audit_events WHERE action='knowledge.reparse'",
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await app.close();
    }
  }));

it("reparses a published item into a replacement run without editing it", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const { batchId, runId } = await f.source();
    const published = await f.item({
      batchId,
      runId,
      title: "等腰三角形",
      summary: "两底角相等",
      status: "published",
    });
    const app = build(db);
    const headers = { ...sessionCookie(f.adminToken), origin: config.origin };
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/admin/knowledge/items/${published}/reparse`,
        headers,
        payload: { extraPrompt: "补充判定定理" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        batchId,
        status: "queued",
        itemCount: 0,
      });

      const job = (
        await db.pool.query("SELECT kind,payload FROM jobs")
      ).rows[0];
      expect(job.kind).toBe("knowledge.parse");
      expect(job.payload).toEqual({
        runId: response.json().id,
        replacesItemId: published,
      });
      expect(
        (
          await db.pool.query(
            "SELECT title,summary,status FROM knowledge_items WHERE id=$1",
            [published],
          )
        ).rows[0],
      ).toMatchObject({
        title: "等腰三角形",
        summary: "两底角相等",
        status: "published",
      });
    } finally {
      await app.close();
    }
  }));

it("confirms a replacement by updating the published item in place", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const { batchId, runId } = await f.source();
    const original = await f.item({
      batchId,
      runId,
      title: "分数加减法",
      summary: "旧总结",
      status: "published",
    });
    const draft = await f.item({
      batchId,
      runId,
      title: "分数加减法（修订）",
      summary: "新总结：先通分再计算",
      replacesItemId: original,
    });
    const app = build(db);
    const headers = { ...sessionCookie(f.adminToken), origin: config.origin };
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/knowledge/items/publish",
        headers,
        payload: { ids: [draft] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveLength(1);
      expect(response.json()[0]).toMatchObject({
        id: original,
        title: "分数加减法（修订）",
        summary: "新总结：先通分再计算",
        status: "published",
      });

      const originalRow = (
        await db.pool.query(
          "SELECT title,summary,status,updated_at FROM knowledge_items WHERE id=$1",
          [original],
        )
      ).rows[0];
      expect(originalRow).toMatchObject({
        title: "分数加减法（修订）",
        summary: "新总结：先通分再计算",
        status: "published",
      });
      const draftRow = (
        await db.pool.query(
          "SELECT status,replaces_item_id FROM knowledge_items WHERE id=$1",
          [draft],
        )
      ).rows[0];
      expect(draftRow.status).toBe("discarded");
      expect(draftRow.replaces_item_id).toBe(original);

      const visible = await db.pool.query(
        "SELECT summary FROM knowledge_items WHERE status='published' AND (title ILIKE '%通分%' OR summary ILIKE '%通分%')",
      );
      expect(visible.rows.map((row) => row.summary)).toEqual([
        "新总结：先通分再计算",
      ]);
    } finally {
      await app.close();
    }
  }));

it("records a failed reparse when the model is not configured", async () =>
  withTestDb(async (db) => {
    const f = await fixture(db);
    const { batchId, runId } = await f.source();
    const published = await f.item({
      batchId,
      runId,
      title: "已发布",
      summary: "总结",
      status: "published",
    });
    const app = build(db, false);
    const headers = { ...sessionCookie(f.adminToken), origin: config.origin };
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/admin/knowledge/items/${published}/reparse`,
        headers,
        payload: { extraPrompt: "再拆一次" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: "failed",
        errorCode: "MODEL_NOT_CONFIGURED",
        itemCount: 0,
      });
      expect(
        (await db.pool.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n,
      ).toBe(0);
    } finally {
      await app.close();
    }
  }));
