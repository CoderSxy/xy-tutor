import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { sessionCookie } from "../helpers/student-insights.js";
import { SelectionService } from "../../apps/server/src/modules/learning/selections.js";
import { buildApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import type { Database } from "../../packages/db/src/client.js";

const password = "long-test-password";
const config = loadConfig({ NODE_ENV: "test" });

async function retiredFixture(db: Database) {
  const f = await catalogFixture(db);
  const adminToken = (await f.auth.login({ login: "admin", password }))
    .sessionToken;
  const studentToken = (await f.auth.login({ login: "student", password }))
    .sessionToken;
  const app = buildApp({ database: db, config });
  const call = (
    token: string,
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    app.inject({
      method,
      url,
      headers: { ...sessionCookie(token), origin: config.origin },
      ...(payload ? { payload } : {}),
    });
  return { ...f, app, adminToken, studentToken, call };
}

const studentGone = {
  error: { code: "GONE", message: "教材选择已下线，请直接开始学习" },
};
const adminGone = {
  error: { code: "GONE", message: "教材管理已下线，请改用知识点接口" },
};
it("persists one recent selection per student grade and subject across service instances", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const a = await f.publish("人教版", "第一版本");
    const b = await f.publish("苏教版", "第二版本");
    const s = new SelectionService(db, f.auth);
    await s.record(f.scope, { revisionId: a.id });
    await s.record(f.scope, { revisionId: a.id });
    await s.record(f.scope, { revisionId: b.id });
    const history = await new SelectionService(db, f.auth).list(f.scope);
    expect(history).toHaveLength(1);
    expect(history[0]?.revisionId).toBe(b.id);
    expect(history[0]?.edition).toBe("苏教版");
    await f.catalog.disable(f.admin, b.id);
    expect((await s.list(f.scope))[0]?.status).toBe("disabled");
    await expect(s.record(f.scope, { revisionId: b.id })).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
  }));
it("orders recent subject selections and rejects foreign student access", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const a = await f.publish("人教版", "数学");
    const b = await f.publish("苏教版", "英语");
    const subject = (
      await db.pool.query(
        "INSERT INTO subjects(name) VALUES('英语') RETURNING id",
      )
    ).rows[0].id;
    await db.pool.query(
      "UPDATE textbooks SET subject_id=$1 WHERE id=(SELECT textbook_id FROM textbook_revisions WHERE id=$2)",
      [subject, b.id],
    );
    const s = new SelectionService(db, f.auth);
    await s.record(f.scope, { revisionId: a.id });
    await s.record(f.scope, { revisionId: b.id });
    await s.record(f.scope, { revisionId: a.id });
    expect((await s.list(f.scope)).map((r) => r.subject)).toEqual([
      "数学",
      "英语",
    ]);
    await expect(
      s.list({ ...f.scope, studentId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }));

it("retires student textbook and selection endpoints with 410", async () =>
  withTestDb(async (db) => {
    const f = await retiredFixture(db);
    const revision = await f.publish("人教版", "分数");
    const urls: [string, "GET" | "POST"][] = [
      ["/api/catalog/textbooks", "GET"],
      [`/api/catalog/textbooks/${revision.id}`, "GET"],
      [`/api/catalog/textbooks/${revision.id}/pages`, "GET"],
      ["/api/learning/selections", "GET"],
    ];
    for (const [url, method] of urls) {
      const response = await f.call(f.studentToken, method, url);
      expect(response.statusCode).toBe(410);
      expect(response.json()).toEqual(studentGone);
    }
    const record = await f.call(
      f.studentToken,
      "POST",
      "/api/learning/selections",
      { revisionId: revision.id },
    );
    expect(record.statusCode).toBe(410);
    expect(record.json()).toEqual(studentGone);
    await f.app.close();
  }));

it("retires admin textbook endpoints and keeps knowledge and legacy rows", async () =>
  withTestDb(async (db) => {
    const f = await retiredFixture(db);
    const revision = await f.publish("人教版", "分数");
    const adminUrls: [string, "GET" | "POST" | "PATCH"][] = [
      ["/api/admin/textbooks", "GET"],
      ["/api/admin/textbooks", "POST"],
      [`/api/admin/textbooks/${revision.id}/process`, "POST"],
      [`/api/admin/textbooks/${revision.id}/pages`, "PATCH"],
      [`/api/admin/textbooks/${revision.id}/publish`, "POST"],
      [`/api/admin/textbooks/${revision.id}/disable`, "POST"],
    ];
    for (const [url, method] of adminUrls) {
      const response = await f.call(f.adminToken, method, url);
      expect(response.statusCode).toBe(410);
      expect(response.json()).toEqual(adminGone);
    }
    const knowledge = await f.call(
      f.adminToken,
      "GET",
      "/api/admin/knowledge/items",
    );
    expect(knowledge.statusCode).toBe(200);
    const legacy = await db.pool.query<{ textbooks: number; revisions: number }>(
      "SELECT (SELECT count(*)::int FROM textbooks) AS textbooks,(SELECT count(*)::int FROM textbook_revisions) AS revisions",
    );
    expect(legacy.rows[0]).toEqual({ textbooks: 1, revisions: 1 });
    await f.app.close();
  }));
