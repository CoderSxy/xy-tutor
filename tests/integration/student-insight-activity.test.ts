import { expect, it } from "vitest";
import type { Database } from "../../packages/db/src/client.js";
import { inTransaction } from "../../packages/db/src/client.js";
import { buildApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { AttemptService } from "../../apps/server/src/modules/learning/attempts.js";
import { RunService } from "../../apps/server/src/modules/conversations/runs.js";
import { MaterialService } from "../../apps/server/src/modules/materials/service.js";
import {
  InsightActivityService,
  initializeInsightCollection,
  recordLearningEvent,
  recordStudentVisit,
} from "../../apps/server/src/modules/student-insights/activity.js";
import {
  dayStartUtc,
  shanghaiToday,
} from "../../apps/server/src/modules/student-insights/metrics.js";
import { catalogFixture } from "../helpers/catalog.js";
import { withTestDb } from "../helpers/database.js";

const password = "long-test-password";

const at = (day: string, hour: number) =>
  new Date(dayStartUtc(day).getTime() + hour * 3_600_000);

async function events(db: Database, studentId: string) {
  return (
    await db.pool.query<{
      event_type: string;
      source_type: string;
      source_id: string;
    }>(
      "SELECT event_type,source_type,source_id FROM student_learning_events WHERE student_id=$1 ORDER BY event_type",
      [studentId],
    )
  ).rows;
}

async function eventCount(db: Database): Promise<number> {
  return (
    await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM student_learning_events",
    )
  ).rows[0]!.n;
}

async function visitDays(db: Database, studentId: string) {
  return (
    await db.pool.query<{ day: string }>(
      "SELECT to_char(local_date,'YYYY-MM-DD') AS day FROM student_daily_visits WHERE student_id=$1 ORDER BY local_date",
      [studentId],
    )
  ).rows.map((row) => row.day);
}

it("rolls learning events back with the business transaction", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    await expect(
      inTransaction(db, async (tx) => {
        await recordLearningEvent(tx, {
          studentId: f.scope.studentId,
          actorId: f.scope.actor.userId,
          eventType: "learning_message_sent",
          sourceType: "message",
          sourceId: crypto.randomUUID(),
          occurredAt: new Date(),
          sourceOrigin: "live",
        });
        throw Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await eventCount(db)).toBe(0);
  }));

it("records one event per idempotent message and answer request", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
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
    const messages = new MessageService(db, f.auth);
    const sent = await messages.append(f.scope, {
      conversationId: task.conversationId,
      role: "user",
      content: "1",
      requestKey: "msg-1",
    });
    await messages.append(f.scope, {
      conversationId: task.conversationId,
      role: "user",
      content: "1",
      requestKey: "msg-1",
    });
    const attempts = new AttemptService(db, f.auth);
    const input = {
      requestKey: "answer-1",
      taskId: task.id,
      questionVersionId: question.questionVersionId,
      answer: "1",
      messageVersionId: sent.versionId,
    };
    const attempt = await attempts.submit(f.scope, input);
    await attempts.submit(f.scope, input);
    expect(await events(db, f.scope.studentId)).toEqual([
      {
        event_type: "answer_submitted",
        source_type: "attempt",
        source_id: attempt.id,
      },
      {
        event_type: "learning_message_sent",
        source_type: "message",
        source_id: sent.id,
      },
    ]);
  }));

it("skips events from admins and viewers instead of treating them as the student", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: revision.id,
      kind: "free_question",
    });
    const invitation = await f.auth.invite(f.admin, { login: "viewer" });
    const viewer = await f.auth.activate({
      token: invitation.activationToken,
      password,
    });
    await f.auth.grantAccess(f.scope, { login: "viewer" });
    // 管理员即使拥有查看权限，也不是学生本人
    await db.pool.query(
      "INSERT INTO student_access(student_id,user_id,permission) VALUES($1,$2,'viewer')",
      [f.scope.studentId, f.admin.userId],
    );
    const messages = new MessageService(db, f.auth);
    await messages.append(
      { actor: f.admin, studentId: f.scope.studentId },
      {
        conversationId: task.conversationId,
        role: "user",
        content: "管理员代发",
      },
    );
    await messages.append(
      {
        actor: { userId: viewer.userId, role: "student" },
        studentId: f.scope.studentId,
      },
      {
        conversationId: task.conversationId,
        role: "user",
        content: "查看者代发",
      },
    );
    expect(await eventCount(db)).toBe(0);
    await messages.append(f.scope, {
      conversationId: task.conversationId,
      role: "user",
      content: "学生本人",
    });
    expect(await eventCount(db)).toBe(1);
  }));

it("does not create events for assistant, system, edits or regenerations", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: revision.id,
      kind: "free_question",
    });
    const messages = new MessageService(db, f.auth);
    const user = await messages.append(f.scope, {
      conversationId: task.conversationId,
      role: "user",
      content: "原问题",
    });
    const answer = await messages.append(f.scope, {
      conversationId: task.conversationId,
      role: "assistant",
      content: "回答",
    });
    await messages.append(f.scope, {
      conversationId: task.conversationId,
      role: "system",
      content: "系统提示",
    });
    await messages.regenerate(f.scope, {
      messageId: answer.id,
      content: "重新生成",
    });
    await messages.edit(f.scope, {
      messageId: user.id,
      expectedVersion: 1,
      content: "更正问题",
    });
    expect(await events(db, f.scope.studentId)).toEqual([
      {
        event_type: "learning_message_sent",
        source_type: "message",
        source_id: user.id,
      },
    ]);
  }));

it("records a material event only when the material is created", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数");
    const upload = await f.uploads.create(f.scope.actor, {
      studentId: f.scope.studentId,
      purpose: "student_material",
      name: "作业.pdf",
      size: 100,
      contentType: "application/pdf",
    });
    f.store.put(upload.key, {
      size: 100,
      contentType: "application/pdf",
      prefix: Buffer.from("%PDF-1.7"),
    });
    await f.uploads.complete(f.scope.actor, upload.fileId);
    const materials = new MaterialService(db, f.auth, f.uploads, f.catalog);
    await expect(
      materials.create(f.scope, {
        fileId: crypto.randomUUID(),
        type: "homework",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await eventCount(db)).toBe(0);
    const material = await materials.create(f.scope, {
      fileId: upload.fileId,
      type: "homework",
      revisionId: revision.id,
    });
    expect(await events(db, f.scope.studentId)).toEqual([
      {
        event_type: "material_submitted",
        source_type: "material",
        source_id: material.id,
      },
    ]);
  }));

it("records one visit per student and Shanghai calendar day", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    await initializeInsightCollection(db, new Date("2026-11-10T00:00:00.000Z"));
    const now = new Date("2026-11-10T04:00:00.000Z");
    await recordStudentVisit(db, f.scope.actor, now);
    await recordStudentVisit(
      db,
      f.scope.actor,
      new Date(now.getTime() + 60_000),
    );
    await recordStudentVisit(
      db,
      f.scope.actor,
      new Date(now.getTime() + 120_000),
    );
    expect(await visitDays(db, f.scope.studentId)).toEqual(["2026-11-10"]);
    // 上海时间 23:59:59 与次日 00:00:00 分属两个自然日
    await recordStudentVisit(
      db,
      f.scope.actor,
      new Date("2026-11-10T15:59:59.000Z"),
    );
    await recordStudentVisit(
      db,
      f.scope.actor,
      new Date("2026-11-10T16:00:00.000Z"),
    );
    expect(await visitDays(db, f.scope.studentId)).toEqual([
      "2026-11-10",
      "2026-11-11",
    ]);
    await recordStudentVisit(db, f.admin, new Date("2026-11-10T05:00:00.000Z"));
    expect(
      (
        await db.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM student_daily_visits",
        )
      ).rows[0]!.n,
    ).toBe(2);
  }));

it("refuses visit payloads that forge the student or the time", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const session = await f.auth.login({ login: "student", password });
    const app = buildApp({
      database: db,
      config: loadConfig({ NODE_ENV: "test" }),
    });
    const headers = {
      cookie: `xy_session=${session.sessionToken}`,
      origin: loadConfig({ NODE_ENV: "test" }).origin,
    };
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/student-visits",
        headers,
        payload,
      });
    expect((await post({ studentId: crypto.randomUUID() })).statusCode).toBe(
      422,
    );
    expect(
      (await post({ occurredAt: "2020-01-01T00:00:00Z" })).statusCode,
    ).toBe(422);
    const ok = await post({});
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(await visitDays(db, f.scope.studentId)).toEqual([
      shanghaiToday(new Date()),
    ]);
    await app.close();
  }));

it("aggregates daily activity with visits coverage and streaks", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数");
    await initializeInsightCollection(db, new Date("2026-11-08T01:00:00.000Z"));
    const task = (
      await db.pool.query<{ id: string }>(
        `INSERT INTO learning_tasks(student_id,revision_id,kind,title,status,created_at,updated_at)
         VALUES($1,$2,'practice','练习','active',$3,$3) RETURNING id`,
        [f.scope.studentId, revision.id, at("2026-11-08", 9)],
      )
    ).rows[0]!.id;
    const deleted = (
      await db.pool.query<{ id: string }>(
        `INSERT INTO learning_tasks(student_id,revision_id,kind,title,status,created_at,updated_at,deleted_at)
         VALUES($1,$2,'practice','已删除','active',$3,$3,$4) RETURNING id`,
        [
          f.scope.studentId,
          revision.id,
          at("2026-11-08", 9),
          at("2026-11-09", 0),
        ],
      )
    ).rows[0]!.id;
    const insertEvent = (day: string, hour: number, taskId: string | null) =>
      db.pool.query(
        `INSERT INTO student_learning_events(
           student_id,actor_id,event_type,source_type,source_id,task_id,revision_id,occurred_at,source_origin
         ) VALUES($1,$2,'answer_submitted','attempt',$3,$4,$5,$6,'live')`,
        [
          f.scope.studentId,
          f.scope.actor.userId,
          crypto.randomUUID(),
          taskId,
          revision.id,
          at(day, hour),
        ],
      );
    await insertEvent("2026-11-09", 10, task);
    await insertEvent("2026-11-09", 11, task);
    await insertEvent("2026-11-10", 10, task);
    // 软删除任务上的事件不计入活跃
    await insertEvent("2026-11-10", 11, deleted);
    await recordStudentVisit(db, f.scope.actor, at("2026-11-08", 12));
    await recordStudentVisit(db, f.scope.actor, at("2026-11-09", 12));
    await recordStudentVisit(db, f.scope.actor, at("2026-11-10", 12));
    const now = at("2026-11-10", 13);
    const activity = await new InsightActivityService(db, () => now).get(
      { actor: f.admin, studentId: f.scope.studentId },
      { from: "2026-11-08", to: "2026-11-10" },
    );
    expect(activity.days.map((day) => day.date)).toEqual([
      "2026-11-08",
      "2026-11-09",
      "2026-11-10",
    ]);
    expect(activity.days.map((day) => day.events)).toEqual([0, 2, 1]);
    expect(activity.days.map((day) => day.active)).toEqual([false, true, true]);
    expect(activity.days.map((day) => day.visits)).toEqual([1, 1, 1]);
    expect(activity.activeDays).toBe(2);
    expect(activity.currentStreak).toBe(2);
    expect(activity.longestStreak).toBe(2);
    expect(activity.visitedDays).toBe(3);
    expect(activity.meta).toMatchObject({
      from: "2026-11-08",
      to: "2026-11-10",
      timezone: "Asia/Shanghai",
      coverage: {
        learning: "partial",
        historicalInferred: false,
        visitsStartedAt: "2026-11-08T01:00:00.000Z",
        backfillVersion: null,
      },
    });
  }));

it("counts a chat message plus an answer on one day as a single active day", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数");
    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, {
      revisionId: revision.id,
      kind: "free_question",
    });
    const question = await tasks.addQuestion(f.scope, task.id, {
      stem: "1 + 1 = ?",
      referenceAnswer: "2",
      role: "original",
    });
    await new RunService(db, f.auth).submit(f.scope, {
      conversationId: task.conversationId,
      requestKey: "run-1",
      message: "2",
      questionVersionId: question.questionVersionId,
      mode: "reply",
    });
    expect(
      (await events(db, f.scope.studentId)).map((e) => e.event_type).sort(),
    ).toEqual(["answer_submitted", "learning_message_sent"]);
    const today = shanghaiToday(new Date());
    const activity = await new InsightActivityService(db).get(
      { actor: f.admin, studentId: f.scope.studentId },
      { from: today, to: today },
    );
    expect(activity.activeDays).toBe(1);
    expect(activity.days[0]?.events).toBe(2);
  }));
