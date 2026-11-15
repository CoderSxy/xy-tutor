import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MistakeService } from "../../apps/server/src/modules/learning/mistakes.js";

async function fixture(db: Parameters<typeof catalogFixture>[0], stem = "1+1=?") {
  const f = await catalogFixture(db);
  const tasks = new TaskService(db, f.auth, f.catalog);
  const task = await tasks.create(f.scope, { kind: "daily_practice" });
  const q = await tasks.addQuestion(f.scope, task.id, {
    stem,
    referenceAnswer: "2",
    role: "original",
  });
  const item = (
    await db.pool.query(
      "SELECT id FROM task_items WHERE task_id=$1 AND question_version_id=$2",
      [task.id, q.questionVersionId],
    )
  ).rows[0];
  return { f, task, questionVersionId: q.questionVersionId, itemId: item.id as string };
}

async function createSet(
  db: Parameters<typeof catalogFixture>[0],
  taskId: string,
  studentId: string,
) {
  return (
    await db.pool.query(
      "INSERT INTO practice_sets(task_id,mode,strategy,seed,scope_snapshot,blueprint) VALUES($1,'step','mixed','seed-1','{}','{}') RETURNING id",
      [taskId],
    )
  ).rows[0].id as string;
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

describe("practice set storage", () => {
  it("defaults legacy question versions to legacy/unchecked", async () =>
    withTestDb(async (db) => {
      const { questionVersionId } = await fixture(db);
      const row = (
        await db.pool.query(
          "SELECT question_type,language_status,language_policy_version,presentation,answer_spec FROM question_versions WHERE id=$1",
          [questionVersionId],
        )
      ).rows[0];
      expect(row.question_type).toBe("legacy");
      expect(row.language_status).toBe("unchecked");
      expect(row.language_policy_version).toBeNull();
      expect(row.presentation).toEqual({});
      expect(row.answer_spec).toEqual({});
    }));

  it("rejects an unknown question type at the database level", async () =>
    withTestDb(async (db) => {
      const { questionVersionId } = await fixture(db);
      await expect(
        db.pool.query(
          "UPDATE question_versions SET question_type='number' WHERE id=$1",
          [questionVersionId],
        ),
      ).rejects.toSatisfy((e) => codeOf(e) === "23514");
    }));

  it("enforces one set per task and five ordered slots", async () =>
    withTestDb(async (db) => {
      const { f, task } = await fixture(db);
      const setId = await createSet(db, task.id, f.scope.studentId);
      await expect(
        createSet(db, task.id, f.scope.studentId),
      ).rejects.toSatisfy((e) => codeOf(e) === "23505");
      await db.pool.query(
        "INSERT INTO practice_set_slots(set_id,position,question_type) VALUES($1,0,'single_choice')",
        [setId],
      );
      await expect(
        db.pool.query(
          "INSERT INTO practice_set_slots(set_id,position,question_type) VALUES($1,0,'fill_blank')",
          [setId],
        ),
      ).rejects.toSatisfy((e) => codeOf(e) === "23505");
      await expect(
        db.pool.query(
          "INSERT INTO practice_set_slots(set_id,position,question_type) VALUES($1,5,'worked')",
          [setId],
        ),
      ).rejects.toSatisfy((e) => codeOf(e) === "23514");
      for (let position = 1; position <= 4; position++)
        await db.pool.query(
          "INSERT INTO practice_set_slots(set_id,position,question_type) VALUES($1,$2,'worked')",
          [setId, position],
        );
      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int AS n FROM practice_set_slots WHERE set_id=$1",
            [setId],
          )
        ).rows[0].n,
      ).toBe(5);
    }));

  it("binds a task item to at most one slot", async () =>
    withTestDb(async (db) => {
      const { f, task, itemId } = await fixture(db);
      const first = await createSet(db, task.id, f.scope.studentId);
      const task2 = await new TaskService(db, f.auth, f.catalog).create(
        f.scope,
        { kind: "daily_practice" },
      );
      const second = await createSet(db, task2.id, f.scope.studentId);
      await db.pool.query(
        "INSERT INTO practice_set_slots(set_id,position,question_type,task_item_id) VALUES($1,0,'single_choice',$2)",
        [first, itemId],
      );
      await expect(
        db.pool.query(
          "INSERT INTO practice_set_slots(set_id,position,question_type,task_item_id) VALUES($1,0,'single_choice',$2)",
          [second, itemId],
        ),
      ).rejects.toSatisfy((e) => codeOf(e) === "23505");
    }));

  it("keeps draft, submission and continuation keys unique", async () =>
    withTestDb(async (db) => {
      const { f, task, itemId } = await fixture(db);
      const setId = await createSet(db, task.id, f.scope.studentId);
      await db.pool.query(
        "INSERT INTO practice_answer_drafts(student_id,task_item_id,payload) VALUES($1,$2,'{}')",
        [f.scope.studentId, itemId],
      );
      await expect(
        db.pool.query(
          "INSERT INTO practice_answer_drafts(student_id,task_item_id,payload) VALUES($1,$2,'{}')",
          [f.scope.studentId, itemId],
        ),
      ).rejects.toSatisfy((e) => codeOf(e) === "23505");
      await db.pool.query(
        "INSERT INTO practice_submissions(set_id,request_key,payload_hash) VALUES($1,'r1','h1')",
        [setId],
      );
      await expect(
        db.pool.query(
          "INSERT INTO practice_submissions(set_id,request_key,payload_hash) VALUES($1,'r1','h2')",
          [setId],
        ),
      ).rejects.toSatisfy((e) => codeOf(e) === "23505");
      const task2 = await new TaskService(db, f.auth, f.catalog).create(
        f.scope,
        { kind: "daily_practice" },
      );
      const next = await createSet(db, task2.id, f.scope.studentId);
      await db.pool.query(
        "INSERT INTO practice_set_continuations(previous_set_id,request_key,payload_hash,new_set_id) VALUES($1,'c1','h1',$2)",
        [setId, next],
      );
      await expect(
        db.pool.query(
          "INSERT INTO practice_set_continuations(previous_set_id,request_key,payload_hash,new_set_id) VALUES($1,'c2','h2',$2)",
          [setId, next],
        ),
      ).rejects.toSatisfy((e) => codeOf(e) === "23505");
    }));

  it("keeps practice preferences one per student", async () =>
    withTestDb(async (db) => {
      const { f } = await fixture(db);
      await db.pool.query(
        "INSERT INTO student_practice_preferences(student_id,mode) VALUES($1,'step')",
        [f.scope.studentId],
      );
      await expect(
        db.pool.query(
          "INSERT INTO student_practice_preferences(student_id,mode) VALUES($1,NULL)",
          [f.scope.studentId],
        ),
      ).rejects.toSatisfy((e) => codeOf(e) === "23505");
    }));

  it("caches one localization per question version and policy", async () =>
    withTestDb(async (db) => {
      const { questionVersionId } = await fixture(db);
      await db.pool.query(
        "INSERT INTO question_localizations(question_version_id,policy_version,payload,status) VALUES($1,'zh-student-v1','{}','ready')",
        [questionVersionId],
      );
      await expect(
        db.pool.query(
          "INSERT INTO question_localizations(question_version_id,policy_version,payload,status) VALUES($1,'zh-student-v1','{}','ready')",
          [questionVersionId],
        ),
      ).rejects.toSatisfy((e) => codeOf(e) === "23505");
    }));
});

describe("mistake provenance defaults", () => {
  it("keeps the original attempt and fills unknown/active defaults", async () =>
    withTestDb(async (db) => {
      const { f, task, questionVersionId } = await fixture(db);
      const attempt = (
        await db.pool.query(
          "INSERT INTO attempts(student_id,task_id,question_version_id,request_key,answer) VALUES($1,$2,$3,'a1','1') RETURNING id",
          [f.scope.studentId, task.id, questionVersionId],
        )
      ).rows[0];
      const saved = await new MistakeService(db, f.auth).add(f.scope, {
        questionVersionId,
        attemptId: attempt.id,
      });
      expect(saved.originalAttemptId).toBe(attempt.id);
      const row = (
        await db.pool.query(
          "SELECT origin_category,origin_detail,lifecycle,original_attempt_id,provenance FROM student_mistakes WHERE id=$1",
          [saved.id],
        )
      ).rows[0];
      expect(row.origin_category).toBe("unknown");
      expect(row.origin_detail).toBe("unknown");
      expect(row.lifecycle).toBe("active");
      expect(row.original_attempt_id).toBe(attempt.id);
      expect(row.provenance).toEqual({});
    }));

  it("stores a structured answer payload on attempts without rewriting answer", async () =>
    withTestDb(async (db) => {
      const { f, task, questionVersionId } = await fixture(db);
      const payload = { kind: "choice", optionIds: ["a"] };
      const row = (
        await db.pool.query(
          "INSERT INTO attempts(student_id,task_id,question_version_id,request_key,answer,answer_payload) VALUES($1,$2,$3,'a2','A',$4) RETURNING answer,answer_payload",
          [f.scope.studentId, task.id, questionVersionId, payload],
        )
      ).rows[0];
      expect(row.answer).toBe("A");
      expect(row.answer_payload).toEqual(payload);
    }));
});
