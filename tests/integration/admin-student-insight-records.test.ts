import { expect, it } from "vitest";
import type { Database } from "../../packages/db/src/client.js";
import type { FileStore } from "../../apps/server/src/infra/oss.js";
import { buildApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { addDays, dayStartUtc } from "../../apps/server/src/modules/student-insights/metrics.js";
import { withTestDb } from "../helpers/database.js";
import {
  adminInsightCookie,
  seedInsightFacts,
  studentInsightsFixture,
  type InsightFactsSeed,
  type StudentInsightsFixture,
} from "../helpers/student-insights.js";

const password = "a-strong-test-password";

const at = (today: string, offset: number, hour: number) =>
  new Date(dayStartUtc(addDays(today, offset)).getTime() + hour * 3_600_000);

function appFor(db: Database, store?: FileStore) {
  return buildApp({
    database: db,
    config: loadConfig({ NODE_ENV: "test" }),
    fileStore: store,
  });
}

function fakeStore() {
  const calls: { key: string; ttlSeconds: number }[] = [];
  const store: FileStore = {
    signUpload: async () => ({ url: "https://upload.example", headers: {} }),
    head: async () => ({
      size: 0,
      contentType: "image/jpeg",
      prefix: Buffer.alloc(0),
    }),
    signDownload: async (key, ttlSeconds) => {
      calls.push({ key, ttlSeconds });
      return `https://download.example/${key}`;
    },
    read: async () => Buffer.alloc(0),
    seal: async (key) => key,
    delete: async () => {},
  };
  return { store, calls };
}

async function get(
  app: ReturnType<typeof buildApp>,
  url: string,
  cookie: { cookie: string },
) {
  return app.inject({ method: "GET", url, headers: cookie });
}

async function auditCount(
  fixture: StudentInsightsFixture,
  action: string,
): Promise<number> {
  return (
    await fixture.db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_events WHERE action=$1",
      [action],
    )
  ).rows[0]!.n;
}

async function insertTaskItems(
  db: Database,
  taskId: string,
  versionIds: string[],
): Promise<void> {
  for (const [position, versionId] of versionIds.entries())
    await db.pool.query(
      `INSERT INTO task_items(task_id,question_version_id,position,role)
       VALUES($1,$2,$3,'practice')`,
      [taskId, versionId, position],
    );
}

async function createConversation(
  db: Database,
  studentId: string,
  revisionId: string,
  taskId: string | null = null,
): Promise<string> {
  return (
    await db.pool.query<{ id: string }>(
      `INSERT INTO conversations(student_id,revision_id,task_id)
       VALUES($1,$2,$3) RETURNING id`,
      [studentId, revisionId, taskId],
    )
  ).rows[0]!.id;
}

async function createMessage(
  db: Database,
  conversationId: string,
  contents: string[],
): Promise<{ messageId: string; versionIds: string[] }> {
  const messageId = (
    await db.pool.query<{ id: string }>(
      `INSERT INTO messages(conversation_id,role,current_version)
       VALUES($1,'assistant',$2) RETURNING id`,
      [conversationId, contents.length],
    )
  ).rows[0]!.id;
  const versionIds: string[] = [];
  for (const [index, content] of contents.entries())
    versionIds.push(
      (
        await db.pool.query<{ id: string }>(
          `INSERT INTO message_versions(message_id,version_no,content)
           VALUES($1,$2,$3) RETURNING id`,
          [messageId, index + 1, content],
        )
      ).rows[0]!.id,
    );
  return { messageId, versionIds };
}

async function createFile(
  db: Database,
  adminUserId: string,
  input: {
    name: string;
    contentType?: string;
    status?: string;
    purpose?: string;
  },
): Promise<{ id: string; objectKey: string }> {
  const objectKey = crypto.randomUUID();
  const row = (
    await db.pool.query<{ id: string }>(
      `INSERT INTO files(owner_id,purpose,name,content_type,size,object_key,status)
       VALUES($1,$2,$3,$4,100,$5,$6) RETURNING id`,
      [
        adminUserId,
        input.purpose ?? "material",
        input.name,
        input.contentType ?? "image/jpeg",
        objectKey,
        input.status ?? "ready",
      ],
    )
  ).rows[0]!;
  return { id: row.id, objectKey };
}

async function attach(
  db: Database,
  messageVersionId: string,
  fileId: string,
  position = 0,
): Promise<void> {
  await db.pool.query(
    `INSERT INTO message_attachments(message_version_id,file_id,position)
     VALUES($1,$2,$3)`,
    [messageVersionId, fileId, position],
  );
}

async function seedConversationId(
  fixture: StudentInsightsFixture,
): Promise<string> {
  return (
    await fixture.db.pool.query<{ id: string }>(
      `SELECT id FROM conversations WHERE student_id=$1 ORDER BY created_at, id LIMIT 1`,
      [fixture.studentA.studentId],
    )
  ).rows[0]!.id;
}

async function seedMessageVersionId(
  fixture: StudentInsightsFixture,
): Promise<string> {
  return (
    await fixture.db.pool.query<{ id: string }>(
      `SELECT mv.id
       FROM message_versions mv
       JOIN messages m ON m.id = mv.message_id
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.student_id = $1
       ORDER BY mv.created_at, mv.id LIMIT 1`,
      [fixture.studentA.studentId],
    )
  ).rows[0]!.id;
}

async function materialFile(
  fixture: StudentInsightsFixture,
  seed: InsightFactsSeed,
): Promise<{ id: string; objectKey: string; status: string }> {
  return (
    await fixture.db.pool.query<{
      id: string;
      objectKey: string;
      status: string;
    }>(
      `SELECT f.id, f.object_key AS "objectKey", f.status
       FROM materials m JOIN files f ON f.id = m.file_id
       WHERE m.id = $1`,
      [seed.material],
    )
  ).rows[0]!;
}

async function mistakeId(
  fixture: StudentInsightsFixture,
  questionId: string,
): Promise<string> {
  return (
    await fixture.db.pool.query<{ id: string }>(
      `SELECT id FROM student_mistakes WHERE student_id=$1 AND question_id=$2`,
      [fixture.studentA.studentId, questionId],
    )
  ).rows[0]!.id;
}

it("任务列表与详情只暴露本学生有效数据，只在打开详情时审计", () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    await insertTaskItems(db, seed.taskA, [
      seed.questionVersionA,
      seed.questionVersionB,
      seed.questionVersionC,
    ]);
    const chapterId = crypto.randomUUID();
    await db.pool.query("UPDATE learning_tasks SET chapter_id=$1 WHERE id=$2", [
      chapterId,
      seed.taskA,
    ]);

    const hintConversation = await createConversation(
      db,
      fixture.studentA.studentId,
      seed.revisionA,
    );
    const hintMessage = await createMessage(db, hintConversation, ["提示内容"]);
    const invalidatedVersionId = await seedMessageVersionId(fixture);
    await db.pool.query(
      `INSERT INTO hints(task_id,question_version_id,message_version_id,level,displayed_at)
       VALUES($1,$2,$3,'nudge',$4),($1,$2,$5,'nudge',$6)`,
      [
        seed.taskA,
        seed.questionVersionA,
        hintMessage.versionIds[0],
        at(seed.today, -6, 10),
        invalidatedVersionId,
        at(seed.today, -6, 11),
      ],
    );

    const app = appFor(db);
    const cookie = adminInsightCookie(fixture);
    const base = `/api/admin/student-insights/students/${fixture.studentA.studentId}`;

    const listed = await get(app, `${base}/tasks`, cookie);
    expect(listed.statusCode).toBe(200);
    const list = listed.json();
    expect(list.total).toBe(1);
    expect(list.items.map((item: { id: string }) => item.id)).toEqual([
      seed.taskA,
    ]);
    expect(list.items[0]).toMatchObject({
      itemCount: 3,
      answeredCount: 3,
      chapterId,
    });
    expect(list.meta.metricVersion).toBe("student-insights-v1");

    const completed = await get(app, `${base}/tasks?status=completed`, cookie);
    expect(completed.json().total).toBe(0);
    const practice = await get(app, `${base}/tasks?kind=practice`, cookie);
    expect(practice.json().total).toBe(1);

    const detail = await get(
      app,
      `${base}/tasks/${seed.taskA}?limit=2`,
      cookie,
    );
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json();
    expect(detailBody.task.id).toBe(seed.taskA);
    expect(detailBody.items.total).toBe(3);
    expect(detailBody.items.items).toHaveLength(2);
    expect(detailBody.items.items[0].position).toBe(0);

    expect(await auditCount(fixture, "student_insight.task_view")).toBe(1);
    const audit = await db.pool.query<{
      details: { taskId: string; requestId: string };
    }>("SELECT details FROM audit_events WHERE action='student_insight.task_view'");
    expect(audit.rows[0]!.details.taskId).toBe(seed.taskA);
    expect(typeof audit.rows[0]!.details.requestId).toBe("string");

    for (let index = 0; index < 2; index += 1)
      await get(app, `${base}/tasks/${seed.taskA}?limit=1&offset=1`, cookie);
    expect(await auditCount(fixture, "student_insight.task_view")).toBe(1);

    const attempts = await get(
      app,
      `${base}/tasks/${seed.taskA}/attempts`,
      cookie,
    );
    expect(attempts.statusCode).toBe(200);
    const attemptBody = attempts.json();
    expect(attemptBody.total).toBe(6);
    const attemptIds = attemptBody.items.map(
      (item: { id: string }) => item.id,
    );
    expect(attemptIds).not.toContain(seed.attemptIds.deletedTask);
    expect(attemptIds).not.toContain(seed.attemptIds.invalidatedQuestion);
    expect(attemptIds).not.toContain(seed.attemptIds.invalidatedMessage);
    expect(attemptIds[0]).toBe(seed.attemptIds.pending);
    expect(await auditCount(fixture, "student_insight.task_view")).toBe(1);

    const first = attemptBody.items.find(
      (item: { id: string }) => item.id === seed.attemptIds.firstA,
    );
    expect(first.assessment).toEqual({
      id: seed.assessmentIds.firstALatest,
      correctness: "correct",
      verification: "verified",
      hintDependency: "none",
      feedback: null,
    });
    expect(first.hints).toEqual([{ level: "nudge", content: "提示内容" }]);

    const pending = attemptBody.items.find(
      (item: { id: string }) => item.id === seed.attemptIds.pending,
    );
    expect(pending.assessment).toBeNull();

    const crossStudent = await get(
      app,
      `/api/admin/student-insights/students/${fixture.studentB.studentId}/tasks/${seed.taskA}`,
      cookie,
    );
    expect(crossStudent.statusCode).toBe(404);

    const secondAdminToken = (
      await fixture.auth.login({
        login: "insight-admin-2",
        password,
      })
    ).sessionToken;
    const asSecondAdmin = await get(app, `${base}/tasks`, {
      cookie: `xy_session=${secondAdminToken}`,
    });
    expect(asSecondAdmin.statusCode).toBe(200);
    expect(asSecondAdmin.json().total).toBe(1);

    const asStudent = await get(app, `${base}/tasks`, {
      cookie: `xy_session=${fixture.studentA.token}`,
    });
    expect(asStudent.statusCode).toBe(403);

    const empty = await get(
      app,
      `/api/admin/student-insights/students/${fixture.emptyStudentId}/tasks`,
      cookie,
    );
    expect(empty.json()).toMatchObject({ items: [], total: 0 });
  }));

it("消息只返回当前未失效版本与 ready 附件", () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const app = appFor(db);
    const cookie = adminInsightCookie(fixture);
    const base = `/api/admin/student-insights/students/${fixture.studentA.studentId}`;

    const seedConversation = await seedConversationId(fixture);
    const hidden = await get(
      app,
      `${base}/conversations/${seedConversation}/messages`,
      cookie,
    );
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().total).toBe(0);

    const conversation = await createConversation(
      db,
      fixture.studentA.studentId,
      seed.revisionA,
    );
    const message = await createMessage(db, conversation, ["旧内容", "新内容"]);
    const ready = await createFile(db, fixture.admin.userId, {
      name: "草稿.png",
      purpose: "message",
    });
    const prepared = await createFile(db, fixture.admin.userId, {
      name: "未就绪.png",
      purpose: "message",
      status: "prepared",
    });
    await attach(db, message.versionIds[1]!, ready.id, 0);
    await attach(db, message.versionIds[1]!, prepared.id, 1);

    const shown = await get(
      app,
      `${base}/conversations/${conversation}/messages`,
      cookie,
    );
    expect(shown.statusCode).toBe(200);
    const body = shown.json();
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      versionNo: 2,
      content: "新内容",
    });
    expect(body.items[0].attachments).toEqual([
      { fileId: ready.id, name: "草稿.png", contentType: "image/jpeg" },
    ]);

    const deletedTaskConversation = await createConversation(
      db,
      fixture.studentA.studentId,
      seed.revisionA,
      seed.deletedTask,
    );
    await createMessage(db, deletedTaskConversation, ["已删除任务"]);
    const hiddenByTask = await get(
      app,
      `${base}/conversations/${deletedTaskConversation}/messages`,
      cookie,
    );
    expect(hiddenByTask.statusCode).toBe(404);

    const foreignConversation = await createConversation(
      db,
      fixture.studentB.studentId,
      seed.revisionA,
    );
    await createMessage(db, foreignConversation, ["别人的消息"]);
    const crossStudent = await get(
      app,
      `${base}/conversations/${foreignConversation}/messages`,
      cookie,
    );
    expect(crossStudent.statusCode).toBe(404);
  }));

it("错题列表支持过滤，事件分页且只在详情审计", () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const chapterId = crypto.randomUUID();
    await db.pool.query("UPDATE learning_tasks SET chapter_id=$1 WHERE id=$2", [
      chapterId,
      seed.taskA,
    ]);

    const app = appFor(db);
    const cookie = adminInsightCookie(fixture);
    const base = `/api/admin/student-insights/students/${fixture.studentA.studentId}`;

    const all = await get(app, `${base}/mistakes`, cookie);
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(2);
    expect(
      all.json().items.every(
        (item: { knowledgePoint: string }) => item.knowledgePoint === "分数",
      ),
    ).toBe(true);

    const byPoint = await get(
      app,
      `${base}/mistakes?knowledgePoint=${encodeURIComponent("函数")}`,
      cookie,
    );
    expect(byPoint.json().total).toBe(0);
    const byChapter = await get(
      app,
      `${base}/mistakes?chapterId=${chapterId}`,
      cookie,
    );
    expect(byChapter.json().total).toBe(2);
    const otherChapter = await get(
      app,
      `${base}/mistakes?chapterId=${crypto.randomUUID()}`,
      cookie,
    );
    expect(otherChapter.json().total).toBe(0);
    const mastered = await get(app, `${base}/mistakes?status=mastered`, cookie);
    expect(mastered.json().total).toBe(0);

    const target = await mistakeId(fixture, seed.questionA);
    for (let index = 0; index < 6; index += 1)
      await db.pool.query(
        `INSERT INTO mistake_state_events
           (mistake_id,type,from_state,to_state,reason,rule_version,evidence_at)
         VALUES($1,'transition','pending_correction','corrected',$2,'v1',$3)`,
        [target, `第${index}次`, at(seed.today, -5 + index, 9)],
      );

    const detail = await get(app, `${base}/mistakes/${target}`, cookie);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().mistake.id).toBe(target);
    expect(detail.json().recentEvents).toHaveLength(5);
    expect(detail.json().recentEvents[0].reason).toBe("第5次");

    const events = await get(
      app,
      `${base}/mistakes/${target}/events?limit=2&offset=0`,
      cookie,
    );
    expect(events.statusCode).toBe(200);
    expect(events.json().total).toBe(6);
    expect(events.json().items).toHaveLength(2);
    expect(await auditCount(fixture, "student_insight.mistake_view")).toBe(1);

    await get(app, `${base}/mistakes/${target}`, cookie);
    expect(await auditCount(fixture, "student_insight.mistake_view")).toBe(2);

    const crossStudent = await get(
      app,
      `/api/admin/student-insights/students/${fixture.studentB.studentId}/mistakes/${target}`,
      cookie,
    );
    expect(crossStudent.statusCode).toBe(404);
  }));

it("资料题目去重计数，文件签名 300 秒且不含 object_key", () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const file = await materialFile(fixture, seed);
    expect(file.status).toBe("prepared");
    await db.pool.query("UPDATE files SET status='ready' WHERE id=$1", [
      file.id,
    ]);

    const { store, calls } = fakeStore();
    const app = appFor(db, store);
    const cookie = adminInsightCookie(fixture);
    const base = `/api/admin/student-insights/students/${fixture.studentA.studentId}`;

    const listed = await get(app, `${base}/materials`, cookie);
    expect(listed.statusCode).toBe(200);
    const body = listed.json();
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: seed.material,
      questions: 1,
      answered: 1,
      verified: 1,
      name: "作业.jpg",
      type: "homework",
    });

    const homework = await get(app, `${base}/materials?types=homework`, cookie);
    expect(homework.json().total).toBe(1);
    const exam = await get(app, `${base}/materials?types=exam`, cookie);
    expect(exam.json().total).toBe(0);
    const processing = await get(
      app,
      `${base}/materials?status=processing`,
      cookie,
    );
    expect(processing.json().total).toBe(0);

    const detail = await get(app, `${base}/materials/${seed.material}`, cookie);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().extraction).toMatchObject({
      versionNo: 1,
      model: "test",
      promptVersion: "v1",
    });
    await get(app, `${base}/materials/${seed.material}`, cookie);
    expect(await auditCount(fixture, "student_insight.material_view")).toBe(1);

    const questions = await get(
      app,
      `${base}/materials/${seed.material}/questions`,
      cookie,
    );
    expect(questions.statusCode).toBe(200);
    expect(questions.json().total).toBe(1);
    expect(questions.json().items[0]).toMatchObject({
      questionId: seed.questionA,
      answered: true,
      verified: true,
    });

    const download = await get(app, `${base}/files/${file.id}/download`, cookie);
    expect(download.statusCode).toBe(200);
    const signed = download.json();
    expect(Object.keys(signed).sort()).toEqual([
      "contentType",
      "expiresAt",
      "url",
    ]);
    expect(signed.contentType).toBe("image/jpeg");
    expect(calls).toEqual([{ key: file.objectKey, ttlSeconds: 300 }]);
    expect(
      new Date(signed.expiresAt).getTime(),
    ).toBeGreaterThan(Date.now() + 290_000);
    expect(await auditCount(fixture, "student_insight.file_download")).toBe(1);

    const orphan = await createFile(db, fixture.admin.userId, {
      name: "孤儿.png",
    });
    expect(
      (await get(app, `${base}/files/${orphan.id}/download`, cookie)).statusCode,
    ).toBe(404);

    const preparedFile = await createFile(db, fixture.admin.userId, {
      name: "未就绪资料.png",
      status: "prepared",
    });
    await db.pool.query(
      `INSERT INTO materials(student_id,file_id,revision_id,type,status)
       VALUES($1,$2,$3,'other','ready')`,
      [fixture.studentA.studentId, preparedFile.id, seed.revisionA],
    );
    expect(
      (await get(app, `${base}/files/${preparedFile.id}/download`, cookie))
        .statusCode,
    ).toBe(404);

    const invalidatedVersionId = await seedMessageVersionId(fixture);
    const invalidatedFile = await createFile(db, fixture.admin.userId, {
      name: "失效消息附件.png",
      purpose: "message",
    });
    await attach(db, invalidatedVersionId, invalidatedFile.id);
    expect(
      (await get(app, `${base}/files/${invalidatedFile.id}/download`, cookie))
        .statusCode,
    ).toBe(404);

    const deletedTaskConversation = await createConversation(
      db,
      fixture.studentA.studentId,
      seed.revisionA,
      seed.deletedTask,
    );
    const deletedTaskMessage = await createMessage(
      db,
      deletedTaskConversation,
      ["已删除任务消息"],
    );
    const deletedTaskFile = await createFile(db, fixture.admin.userId, {
      name: "已删除任务附件.png",
      purpose: "message",
    });
    await attach(db, deletedTaskMessage.versionIds[0]!, deletedTaskFile.id);
    expect(
      (await get(app, `${base}/files/${deletedTaskFile.id}/download`, cookie))
        .statusCode,
    ).toBe(404);

    const foreignFile = await createFile(db, fixture.admin.userId, {
      name: "别人的资料.png",
    });
    await db.pool.query(
      `INSERT INTO materials(student_id,file_id,revision_id,type,status)
       VALUES($1,$2,$3,'other','ready')`,
      [fixture.studentB.studentId, foreignFile.id, seed.revisionA],
    );
    const crossStudent = await get(
      app,
      `/api/admin/student-insights/students/${fixture.studentB.studentId}/files/${foreignFile.id}/download`,
      cookie,
    );
    expect(crossStudent.statusCode).toBe(404);

    const noStore = appFor(db);
    const unavailable = await get(
      noStore,
      `${base}/files/${file.id}/download`,
      cookie,
    );
    expect(unavailable.statusCode).toBe(503);
  }));

it("所有只读查询前后学习数据保持不变", () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    await insertTaskItems(db, seed.taskA, [
      seed.questionVersionA,
      seed.questionVersionB,
    ]);
    const target = await mistakeId(fixture, seed.questionA);
    await db.pool.query(
      `INSERT INTO mistake_state_events
         (mistake_id,type,from_state,to_state,reason,rule_version,evidence_at)
       VALUES($1,'transition','pending_correction','corrected','一次','v1',$2)`,
      [target, at(seed.today, -4, 9)],
    );

    const { store } = fakeStore();
    const app = appFor(db, store);
    const cookie = adminInsightCookie(fixture);
    const base = `/api/admin/student-insights/students/${fixture.studentA.studentId}`;
    const conversation = await seedConversationId(fixture);

    const snapshot = async () =>
      (
        await db.pool.query(
          `SELECT
             (SELECT count(*) FROM learning_tasks) AS tasks,
             (SELECT count(*) FROM task_items) AS items,
             (SELECT count(*) FROM attempts) AS attempts,
             (SELECT count(*) FROM messages) AS messages,
             (SELECT count(*) FROM message_versions) AS versions,
             (SELECT count(*) FROM student_mistakes) AS mistakes,
             (SELECT count(*) FROM mistake_state_events) AS events,
             (SELECT coalesce(sum(extract(epoch from updated_at)),0)::text
                FROM learning_tasks) AS "taskUpdated"`,
        )
      ).rows[0];

    const before = await snapshot();
    const urls = [
      `${base}/tasks`,
      `${base}/tasks/${seed.taskA}`,
      `${base}/tasks/${seed.taskA}/attempts`,
      `${base}/conversations/${conversation}/messages`,
      `${base}/mistakes`,
      `${base}/mistakes/${target}`,
      `${base}/mistakes/${target}/events`,
      `${base}/materials`,
      `${base}/materials/${seed.material}`,
      `${base}/materials/${seed.material}/questions`,
    ];
    for (const url of urls) {
      const response = await get(app, url, cookie);
      expect(response.statusCode).toBe(200);
    }
    expect(await snapshot()).toEqual(before);
  }));
