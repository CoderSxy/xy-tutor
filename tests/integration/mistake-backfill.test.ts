import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import type { Database } from "../../packages/db/src/client.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { AttemptService } from "../../apps/server/src/modules/learning/attempts.js";
import { MistakeService } from "../../apps/server/src/modules/learning/mistakes.js";
import { backfillMistakes } from "../../apps/server/src/modules/learning/mistake-backfill.js";

type Fixture = Awaited<ReturnType<typeof catalogFixture>>;

async function seedTask(f: Fixture) {
  const tasks = new TaskService(f.db, f.auth, f.catalog);
  const task = await tasks.create(f.scope, { kind: "free_question" });
  return { tasks, task };
}

async function addAttempt(
  f: Fixture,
  tasks: TaskService,
  taskId: string,
  conversationId: string,
  stem: string,
  requestKey: string,
) {
  const question = await tasks.addQuestion(f.scope, taskId, {
    stem,
    referenceAnswer: "2",
    role: "original",
  });
  const message = await new MessageService(f.db, f.auth).append(f.scope, {
    conversationId,
    role: "user",
    content: "3",
  });
  const attempt = await new AttemptService(f.db, f.auth).submit(f.scope, {
    taskId,
    questionVersionId: question.questionVersionId,
    messageVersionId: message.versionId,
    answer: "3",
    requestKey,
  });
  return { question, attempt };
}

async function addAssessment(
  db: Database,
  attemptId: string,
  correctness: "correct" | "incorrect" | "uncertain",
  verification: "verified" | "pending",
  createdAt = "now()",
) {
  return (
    await db.pool.query(
      `INSERT INTO assessments(attempt_id,correctness,verification,hint_dependency,method,verifier_version,evidence,created_at)
       VALUES($1,$2,$3,'none','independent','assessment-v1','{}',${createdAt}) RETURNING id`,
      [attemptId, correctness, verification],
    )
  ).rows[0].id as string;
}

async function counts(db: Database) {
  return (
    await db.pool.query(
      "SELECT (SELECT count(*)::int FROM student_mistakes) AS mistakes,(SELECT count(*)::int FROM mistake_state_events) AS events",
    )
  ).rows[0] as { mistakes: number; events: number };
}

it("dry-run writes nothing and repeated apply does not grow mistakes or events", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const { tasks, task } = await seedTask(f);
    const first = await addAttempt(
      f,
      tasks,
      task.id,
      task.conversationId,
      "只填数值：1+1=?",
      "bf-1",
    );
    const firstAssessment = await addAssessment(
      db,
      first.attempt.id,
      "incorrect",
      "verified",
    );
    // A later pending assessment is not a "latest valid verified incorrect".
    const pending = await addAttempt(
      f,
      tasks,
      task.id,
      task.conversationId,
      "只填数值：2+0=?",
      "bf-2",
    );
    await addAssessment(db, pending.attempt.id, "incorrect", "pending");
    // Invalidated evidence is scanned but never written.
    const invalid = await addAttempt(
      f,
      tasks,
      task.id,
      task.conversationId,
      "只填数值：3-1=?",
      "bf-3",
    );
    await addAssessment(db, invalid.attempt.id, "incorrect", "verified");
    await db.pool.query(
      "INSERT INTO evidence_invalidations(student_id,evidence_version_id,reason) VALUES($1,$2,'superseded')",
      [f.scope.studentId, invalid.question.questionVersionId],
    );
    // An existing mistake body excludes the assessment from the candidate set.
    const existing = await addAttempt(
      f,
      tasks,
      task.id,
      task.conversationId,
      "只填数值：0+2=?",
      "bf-4",
    );
    await addAssessment(db, existing.attempt.id, "incorrect", "verified");
    const existingQuestion = (
      await db.pool.query(
        "SELECT question_id AS \"questionId\" FROM question_versions WHERE id=$1",
        [existing.question.questionVersionId],
      )
    ).rows[0].questionId;
    await db.pool.query(
      "INSERT INTO student_mistakes(student_id,question_id,original_attempt_id) VALUES($1,$2,$3)",
      [f.scope.studentId, existingQuestion, existing.attempt.id],
    );
    await db.pool.query(
      "UPDATE jobs SET status='completed' WHERE kind='learning.assess'",
    );

    const service = new MistakeService(db, f.auth);
    const before = await counts(db);
    const dryRun = await backfillMistakes(
      db,
      service,
      { studentId: f.scope.studentId },
      { apply: false, batchSize: 100 },
    );
    expect(dryRun.inserted).toBe(0);
    expect(dryRun.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assessmentId: firstAssessment,
          status: "eligible",
        }),
        expect.objectContaining({
          assessmentId: expect.any(String),
          status: "skipped",
          reasonCode: "INVALID_EVIDENCE",
        }),
      ]),
    );
    expect(dryRun.scanned).toBe(2);
    expect(dryRun.eligible).toBe(1);
    expect(await counts(db)).toEqual(before);

    const applied = await backfillMistakes(
      db,
      service,
      { studentId: f.scope.studentId },
      { apply: true, batchSize: 100 },
    );
    expect(applied.inserted).toBe(1);
    const afterApply = await counts(db);
    expect(afterApply).toEqual({ mistakes: 2, events: before.events + 1 });

    const again = await backfillMistakes(
      db,
      service,
      { studentId: f.scope.studentId },
      { apply: true, batchSize: 100 },
    );
    expect(again.inserted).toBe(0);
    expect(await counts(db)).toEqual(afterApply);
  }));

it("infers uploaded, learning and unknown origins from existing evidence", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const { tasks, task } = await seedTask(f);
    const learning = await addAttempt(
      f,
      tasks,
      task.id,
      task.conversationId,
      "练习来源：1+1=?",
      "origin-1",
    );
    await addAssessment(db, learning.attempt.id, "incorrect", "verified");

    const uploaded = await db.pool.query(
      "INSERT INTO questions(student_id,source_type) VALUES($1,'material') RETURNING id",
      [f.scope.studentId],
    );
    const uploadedVersion = await db.pool.query(
      "INSERT INTO question_versions(question_id,version_no,stem,reference_answer,verification) VALUES($1,1,'上传题：1+1=?','2','verified') RETURNING id",
      [uploaded.rows[0].id],
    );
    const uploadedAttempt = await db.pool.query(
      "INSERT INTO attempts(student_id,question_version_id,request_key,answer) VALUES($1,$2,'origin-uploaded','3') RETURNING id",
      [f.scope.studentId, uploadedVersion.rows[0].id],
    );
    await addAssessment(db, uploadedAttempt.rows[0].id, "incorrect", "verified");

    const unknown = await db.pool.query(
      "INSERT INTO questions(student_id,source_type) VALUES($1,'manual') RETURNING id",
      [f.scope.studentId],
    );
    const unknownVersion = await db.pool.query(
      "INSERT INTO question_versions(question_id,version_no,stem,reference_answer,verification) VALUES($1,1,'来源不明：1+1=?','2','verified') RETURNING id",
      [unknown.rows[0].id],
    );
    const unknownAttempt = await db.pool.query(
      "INSERT INTO attempts(student_id,question_version_id,request_key,answer) VALUES($1,$2,'origin-unknown','3') RETURNING id",
      [f.scope.studentId, unknownVersion.rows[0].id],
    );
    await addAssessment(db, unknownAttempt.rows[0].id, "incorrect", "verified");
    await db.pool.query(
      "UPDATE jobs SET status='completed' WHERE kind='learning.assess'",
    );

    const report = await backfillMistakes(
      db,
      new MistakeService(db, f.auth),
      { studentId: f.scope.studentId },
      { apply: true, batchSize: 100 },
    );
    expect(report.inserted).toBe(3);
    const origins = (
      await db.pool.query(
        `SELECT q.source_type AS "sourceType",m.origin_category AS "originCategory"
         FROM student_mistakes m JOIN questions q ON q.id=m.question_id`,
      )
    ).rows;
    expect(origins).toEqual(
      expect.arrayContaining([
        { sourceType: "practice", originCategory: "learning" },
        { sourceType: "material", originCategory: "uploaded" },
        { sourceType: "manual", originCategory: "unknown" },
      ]),
    );
  }));

it("pages by a stable cursor without skipping eligible assessments", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const { tasks, task } = await seedTask(f);
    const expected: string[] = [];
    for (let index = 0; index < 3; index++) {
      const row = await addAttempt(
        f,
        tasks,
        task.id,
        task.conversationId,
        `分页题 ${index}`,
        `page-${index}`,
      );
      expected.push(
        await addAssessment(
          db,
          row.attempt.id,
          "incorrect",
          "verified",
          `now()-interval '${10 - index} minutes'`,
        ),
      );
    }
    const service = new MistakeService(db, f.auth);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const report = await backfillMistakes(
        db,
        service,
        { studentId: f.scope.studentId },
        { apply: false, batchSize: 1, ...(cursor ? { cursor } : {}) },
      );
      seen.push(...report.items.map((item) => item.assessmentId));
      expect(report.scanned).toBeLessThanOrEqual(1);
      if (!report.nextCursor) break;
      cursor = report.nextCursor;
    }
    expect(seen).toEqual(expected);
  }));

it("ignores chat-only claims of error without a verified assessment", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const { task } = await seedTask(f);
    await new MessageService(f.db, f.auth).append(f.scope, {
      conversationId: task.conversationId,
      role: "assistant",
      content: "你做错了，正确答案是 2。",
    });
    await db.pool.query(
      "UPDATE jobs SET status='completed' WHERE kind='learning.assess'",
    );
    const report = await backfillMistakes(
      db,
      new MistakeService(db, f.auth),
      { studentId: f.scope.studentId },
      { apply: true, batchSize: 100 },
    );
    expect(report.scanned).toBe(0);
    expect(report.inserted).toBe(0);
    expect(await counts(db)).toEqual({ mistakes: 0, events: 0 });
  }));
