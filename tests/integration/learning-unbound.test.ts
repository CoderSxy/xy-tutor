import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { BootstrapService } from "../../apps/server/src/agent/bootstrap.js";
import { RunService } from "../../apps/server/src/modules/conversations/runs.js";
import { buildContext } from "../../apps/server/src/agent/context.js";
import type { CatalogService } from "../../apps/server/src/modules/catalog/service.js";

const noTextbookRequests = {
  async getRevision() {
    throw new Error("不应请求教材详情");
  },
} as unknown as CatalogService;

it("creates a task and conversation without a textbook", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const tasks = new TaskService(db, f.auth, noTextbookRequests);
    const task = await tasks.create(f.scope, { kind: "free_question" });

    expect(task.revisionId).toBeNull();
    const taskRow = (
      await db.pool.query(
        "SELECT revision_id FROM learning_tasks WHERE id=$1",
        [task.id],
      )
    ).rows[0];
    expect(taskRow.revision_id).toBeNull();
    const conversation = (
      await db.pool.query(
        "SELECT revision_id FROM conversations WHERE id=$1",
        [task.conversationId],
      )
    ).rows[0];
    expect(conversation.revision_id).toBeNull();
  }));

it("ignores a stale revision id from old clients", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数");
    const tasks = new TaskService(db, f.auth, noTextbookRequests);
    const task = await tasks.create(f.scope, {
      revisionId: revision.id,
      kind: "free_question",
    });

    expect(task.revisionId).toBeNull();
    const row = (
      await db.pool.query(
        "SELECT revision_id FROM learning_tasks WHERE id=$1",
        [task.id],
      )
    ).rows[0];
    expect(row.revision_id).toBeNull();
  }));

it("opens one entry conversation per key without a textbook", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const bootstrap = new BootstrapService(
      db,
      f.auth,
      noTextbookRequests,
      new RunService(db, f.auth),
    );
    const first = await bootstrap.open(f.scope, { entryKey: "home" });
    const again = await bootstrap.open(f.scope, { entryKey: "home" });

    expect(again.conversationId).toBe(first.conversationId);
    const entry = (
      await db.pool.query(
        "SELECT revision_id FROM learning_entries WHERE conversation_id=$1",
        [first.conversationId],
      )
    ).rows[0];
    expect(entry.revision_id).toBeNull();
    expect(
      (
        await db.pool.query(
          "SELECT revision_id FROM conversations WHERE id=$1",
          [first.conversationId],
        )
      ).rows[0].revision_id,
    ).toBeNull();
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM conversations"))
        .rows[0].n,
    ).toBe(1);
  }));

it("opens an old conversation that still carries a revision", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数");
    const conversation = (
      await db.pool.query(
        "INSERT INTO conversations(student_id,revision_id) VALUES($1,$2) RETURNING id",
        [f.scope.studentId, revision.id],
      )
    ).rows[0];

    const context = await buildContext(
      db,
      f.auth,
      noTextbookRequests,
      f.scope,
      conversation.id,
      8000,
    );
    expect(context.revisionId).toBeUndefined();
    expect(context.systemContext).not.toContain(revision.id);
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM messages")).rows[0]
        .n,
    ).toBe(0);
  }));

it("keeps knowledge states unique per student and knowledge point", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const insert = (point: string) =>
      db.pool.query(
        "INSERT INTO student_knowledge_states(student_id,revision_id,knowledge_point,evidence_stats) VALUES($1,NULL,$2,'{}')",
        [f.scope.studentId, point],
      );
    await insert("分数");
    await insert("小数");
    await expect(insert("分数")).rejects.toThrow();
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM student_knowledge_states",
        )
      ).rows[0].n,
    ).toBe(2);
  }));

it("keeps learning entries unique per student and entry key", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const conversation = (
      await db.pool.query(
        "INSERT INTO conversations(student_id) VALUES($1) RETURNING id",
        [f.scope.studentId],
      )
    ).rows[0];
    const insert = (key: string) =>
      db.pool.query(
        "INSERT INTO learning_entries(student_id,entry_key,conversation_id) VALUES($1,$2,$3)",
        [f.scope.studentId, key, conversation.id],
      );
    await insert("home");
    await expect(insert("home")).rejects.toThrow();
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM learning_entries"))
        .rows[0].n,
    ).toBe(1);
  }));
