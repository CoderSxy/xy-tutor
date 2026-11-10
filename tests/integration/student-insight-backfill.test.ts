import { expect, it } from "vitest";
import type pg from "pg";
import type { Database } from "../../packages/db/src/client.js";
import { inTransaction } from "../../packages/db/src/client.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { initializeInsightCollection } from "../../apps/server/src/modules/student-insights/activity.js";
import { backfillStudentInsights } from "../../apps/server/src/modules/student-insights/backfill.js";
import { readCoverage } from "../../apps/server/src/modules/student-insights/queries.js";
import { dayStartUtc } from "../../apps/server/src/modules/student-insights/metrics.js";
import { catalogFixture } from "../helpers/catalog.js";
import { withTestDb } from "../helpers/database.js";

const VERSION = "student-insights-backfill-v2:2026-10-01:2026-11-10";
const startedAt = dayStartUtc("2026-11-01");
const historicalAt = new Date("2026-10-20T02:00:00.000Z");

type Fixture = Awaited<ReturnType<typeof catalogFixture>>;

async function seedHistory(
  db: Database,
  f: Fixture,
  afterSwitchAt: Date,
): Promise<{
  attemptId: string;
  messageId: string;
  materialId: string;
  assistantId: string;
  afterSwitchId: string;
}> {
  const revision = await f.publish("人教版", "分数");
  const tasks = new TaskService(db, f.auth, f.catalog);
  const task = await tasks.create(f.scope, {
    revisionId: revision.id,
    kind: "daily_practice",
  });
  const question = await tasks.addQuestion(f.scope, task.id, {
    stem: "1/2 + 1/2 = ?",
    referenceAnswer: "1",
    role: "original",
  });
  const sent = await new MessageService(db, f.auth).append(f.scope, {
    conversationId: task.conversationId,
    role: "user",
    content: "历史问题",
  });
  // 服务写入会留下 live 事件，这里只保留原始业务行用于回填。
  await db.pool.query("DELETE FROM student_learning_events");
  await db.pool.query(
    "UPDATE learning_tasks SET created_at=$2, updated_at=$2 WHERE id=$1",
    [task.id, historicalAt],
  );
  await db.pool.query("UPDATE conversations SET created_at=$2 WHERE id=$1", [
    task.conversationId,
    historicalAt,
  ]);
  await db.pool.query("UPDATE messages SET created_at=$2 WHERE id=$1", [
    sent.id,
    historicalAt,
  ]);
  const attemptId = (
    await db.pool.query<{ id: string }>(
      `INSERT INTO attempts(
         student_id, task_id, question_version_id, message_version_id,
         request_key, answer, created_at
       ) VALUES($1,$2,$3,$4,'hist-answer','1',$5) RETURNING id`,
      [
        f.scope.studentId,
        task.id,
        question.questionVersionId,
        sent.versionId,
        historicalAt,
      ],
    )
  ).rows[0]!.id;
  const upload = await f.uploads.create(f.scope.actor, {
    studentId: f.scope.studentId,
    purpose: "student_material",
    name: "历史作业.pdf",
    size: 100,
    contentType: "application/pdf",
  });
  const materialId = (
    await db.pool.query<{ id: string }>(
      `INSERT INTO materials(student_id, file_id, revision_id, type, created_at)
       VALUES($1,$2,$3,'homework',$4) RETURNING id`,
      [f.scope.studentId, upload.fileId, revision.id, historicalAt],
    )
  ).rows[0]!.id;
  const assistantId = (
    await db.pool.query<{ id: string }>(
      `INSERT INTO messages(conversation_id, role, created_at)
       VALUES($1,'assistant',$2) RETURNING id`,
      [task.conversationId, new Date(historicalAt.getTime() + 2 * 3_600_000)],
    )
  ).rows[0]!.id;
  const afterSwitchId = (
    await db.pool.query<{ id: string }>(
      `INSERT INTO messages(conversation_id, role, created_at)
       VALUES($1,'user',$2) RETURNING id`,
      [task.conversationId, afterSwitchAt],
    )
  ).rows[0]!.id;
  return {
    attemptId,
    messageId: sent.id,
    materialId,
    assistantId,
    afterSwitchId,
  };
}

async function eventRows(db: Database) {
  return (
    await db.pool.query<{
      event_type: string;
      source_type: string;
      source_id: string;
      source_origin: string;
      actor_id: string | null;
      occurred_at: Date;
    }>(
      `SELECT event_type, source_type, source_id, source_origin,
         actor_id, occurred_at
       FROM student_learning_events ORDER BY event_type`,
    )
  ).rows;
}

async function eventTotal(db: Database): Promise<number> {
  return (
    await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM student_learning_events",
    )
  ).rows[0]!.n;
}

async function coverage(db: Database, from: string, to: string) {
  return inTransaction(db, (tx) => readCoverage(tx, { from, to }));
}

function failingDatabase(db: Database, failAt: number): Database {
  let inserts = 0;
  const wrap = (client: pg.PoolClient) => ({
    query: (sql: string, params?: unknown[]) => {
      if (sql.startsWith("INSERT INTO student_learning_events")) {
        inserts += 1;
        if (inserts >= failAt) return Promise.reject(Error("injected failure"));
      }
      return client.query(sql, params as never);
    },
    release: () => client.release(),
  });
  return {
    ...db,
    pool: {
      connect: async () => wrap(await db.pool.connect()),
    },
  } as unknown as Database;
}

it("backfills historical activity with an honest coverage range", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    await initializeInsightCollection(db, startedAt);
    const seed = await seedHistory(
      db,
      f,
      new Date(startedAt.getTime() + 3_600_000),
    );

    const result = await backfillStudentInsights(db, {
      from: "2026-10-01",
      to: "2026-11-10",
    });
    expect(result).toEqual({
      scanned: 3,
      inserted: 3,
      coverageStatus: "complete",
    });

    const events = await eventRows(db);
    expect(events.map((row) => [row.event_type, row.source_id])).toEqual([
      ["answer_submitted", seed.attemptId],
      ["learning_message_sent", seed.messageId],
      ["material_submitted", seed.materialId],
    ]);
    for (const row of events) {
      expect(row.source_origin).toBe("historical_inferred");
      expect(row.actor_id).toBeNull();
      expect(row.occurred_at.toISOString()).toBe(historicalAt.toISOString());
    }
    // 助手消息与切换后的用户消息都不属于历史回填。
    expect(events.some((row) => row.source_id === seed.assistantId)).toBe(
      false,
    );
    expect(events.some((row) => row.source_id === seed.afterSwitchId)).toBe(
      false,
    );
    // 访问活跃没有历史数据，绝不允许伪造。
    expect(
      (
        await db.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM student_daily_visits",
        )
      ).rows[0]!.n,
    ).toBe(0);

    expect(
      (await coverage(db, "2026-10-01", "2026-11-10")).learningComplete,
    ).toBe(false);
    expect(await coverage(db, "2026-10-01", "2026-10-31")).toEqual({
      visitsStartedAt: startedAt.toISOString(),
      backfillVersion: VERSION,
      learningComplete: true,
    });
    const row = (
      await db.pool.query<{ status: string; toDate: string }>(
        `SELECT status, to_char(to_date,'YYYY-MM-DD') AS "toDate"
         FROM student_insight_backfills WHERE version=$1`,
        [VERSION],
      )
    ).rows[0];
    expect(row).toEqual({ status: "completed", toDate: "2026-10-31" });
  }));

it("keeps dry runs read-only", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    await initializeInsightCollection(db, startedAt);
    await seedHistory(db, f, new Date(startedAt.getTime() + 3_600_000));
    const result = await backfillStudentInsights(db, {
      from: "2026-10-01",
      to: "2026-11-10",
      dryRun: true,
    });
    expect(result).toEqual({
      scanned: 3,
      inserted: 3,
      coverageStatus: "complete",
    });
    expect(await eventTotal(db)).toBe(0);
    expect(
      (
        await db.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM student_insight_backfills",
        )
      ).rows[0]!.n,
    ).toBe(0);
  }));

it("never downgrades live events and stays idempotent on re-runs", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    await initializeInsightCollection(db, startedAt);
    const seed = await seedHistory(
      db,
      f,
      new Date(startedAt.getTime() + 3_600_000),
    );
    await db.pool.query(
      `INSERT INTO student_learning_events(
         student_id, actor_id, event_type, source_type, source_id,
         task_id, revision_id, occurred_at, source_origin
       ) VALUES($1,$2,'answer_submitted','attempt',$3,NULL,NULL,$4,'live')`,
      [f.scope.studentId, f.scope.actor.userId, seed.attemptId, historicalAt],
    );

    const first = await backfillStudentInsights(db, {
      from: "2026-10-01",
      to: "2026-11-10",
    });
    expect(first.inserted).toBe(2);
    const second = await backfillStudentInsights(db, {
      from: "2026-10-01",
      to: "2026-11-10",
    });
    expect(second.inserted).toBe(0);
    expect(await eventTotal(db)).toBe(3);
    expect(
      (
        await db.pool.query<{ origin: string }>(
          `SELECT source_origin AS origin FROM student_learning_events
           WHERE source_id=$1`,
          [seed.attemptId],
        )
      ).rows[0]!.origin,
    ).toBe("live");
  }));

it("keeps a failed batch partial and resumes from the last commit", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    await initializeInsightCollection(db, startedAt);
    await seedHistory(db, f, new Date(startedAt.getTime() + 3_600_000));

    await expect(
      backfillStudentInsights(failingDatabase(db, 2), {
        from: "2026-10-01",
        to: "2026-11-10",
        batchSize: 1,
      }),
    ).rejects.toThrow("injected failure");
    // 第一个批次（attempt）已提交，失败批次整体回滚。
    expect(await eventTotal(db)).toBe(1);
    const partial = (
      await db.pool.query<{ status: string; cursor: unknown }>(
        `SELECT status, last_source_cursor AS cursor
         FROM student_insight_backfills WHERE version=$1`,
        [VERSION],
      )
    ).rows[0]!;
    expect(partial.status).toBe("partial");
    expect(Object.keys(partial.cursor as object)).toEqual(["attempt"]);

    const resumed = await backfillStudentInsights(db, {
      from: "2026-10-01",
      to: "2026-11-10",
      batchSize: 1,
    });
    expect(resumed.inserted).toBe(2);
    expect(await eventTotal(db)).toBe(3);
    expect(
      (
        await db.pool.query<{ status: string }>(
          "SELECT status FROM student_insight_backfills WHERE version=$1",
          [VERSION],
        )
      ).rows[0]!.status,
    ).toBe("completed");
  }));

it("lets only one process hold the backfill lock", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    await initializeInsightCollection(db, startedAt);
    await seedHistory(db, f, new Date(startedAt.getTime() + 3_600_000));
    const holder = await db.pool.connect();
    try {
      const lock = await holder.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS ok",
        ["student_insight_backfill", VERSION],
      );
      expect(lock.rows[0]!.ok).toBe(true);
      await expect(
        backfillStudentInsights(db, {
          from: "2026-10-01",
          to: "2026-11-10",
        }),
      ).rejects.toThrow("已有回填任务正在执行");
    } finally {
      await holder.query(
        "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
        ["student_insight_backfill", VERSION],
      );
      holder.release();
    }
  }));
