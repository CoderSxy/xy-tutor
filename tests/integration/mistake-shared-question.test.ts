import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { AttemptService } from "../../apps/server/src/modules/learning/attempts.js";
import { MistakeService } from "../../apps/server/src/modules/learning/mistakes.js";
import type { Database } from "../../packages/db/src/client.js";

type Fixture = Awaited<ReturnType<typeof catalogFixture>>;

async function seedSharedQuestion(
  db: Database,
  f: Fixture,
  revisionId: string,
  stem = "只填数值：2+3=?",
): Promise<string> {
  // Tasks created through TaskService keep revision_id NULL, so the shared
  // question must be usable from the same (null) revision scope.
  const q = (
    await db.pool.query(
      "INSERT INTO questions(student_id,revision_id,source_type) VALUES(NULL,NULL,'shared_upload') RETURNING id",
    )
  ).rows[0];
  const v = (
    await db.pool.query(
      "INSERT INTO question_versions(question_id,version_no,stem,reference_answer) VALUES($1,1,$2,'5') RETURNING id",
      [q.id, stem],
    )
  ).rows[0];
  await db.pool.query(
    "INSERT INTO question_bank_entries(question_version_id,difficulty_band,complexity_band,visibility,source_type,content_fingerprint,status,published_at,created_by) VALUES($1,'easy',1,'shared','shared_upload',$2,'published',now(),$3)",
    [v.id, `fingerprint-${v.id}`, f.admin.userId],
  );
  return v.id;
}

async function answerShared(
  db: Database,
  f: Fixture,
  taskId: string,
  conversationId: string,
  questionVersionId: string,
  requestKey: string,
) {
  const messages = new MessageService(db, f.auth);
  const msg = await messages.append(f.scope, {
    conversationId,
    role: "user",
    content: "5",
  });
  const attempt = await new AttemptService(db, f.auth).submit(f.scope, {
    taskId,
    questionVersionId,
    messageVersionId: msg.versionId,
    answer: "5",
    requestKey,
  });
  return attempt;
}

async function setupShared(db: Database) {
  const f = await catalogFixture(db);
  const r = await f.publish("人教版", "加法");
  const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
    revisionId: r.id,
    kind: "daily_practice",
  });
  const questionVersionId = await seedSharedQuestion(db, f, r.id);
  await db.pool.query(
    "INSERT INTO task_items(task_id,question_version_id,position,role) VALUES($1,$2,0,'original')",
    [task.id, questionVersionId],
  );
  return { f, task, questionVersionId };
}

describe("shared questions in scoped mistakes", () => {
  it("admits a shared question with a legal task item and attempt", async () =>
    withTestDb(async (db) => {
      const { f, task, questionVersionId } = await setupShared(db);
      const attempt = await answerShared(
        db,
        f,
        task.id,
        task.conversationId,
        questionVersionId,
        "shared-ok",
      );
      const saved = await new MistakeService(db, f.auth).add(f.scope, {
        questionVersionId,
        attemptId: attempt.id,
      });
      expect(saved.originCategory).toBe("learning");
      expect(saved.originDetail).toBe("daily_practice");
      expect(saved.originalAttemptId).toBe(attempt.id);
      expect(saved.originTaskId).toBe(task.id);
      expect(saved.originQuestionVersionId).toBe(questionVersionId);
      expect(saved.lifecycle).toBe("active");
    }));

  it("rejects a shared question without a legal task and attempt", async () =>
    withTestDb(async (db) => {
      const { f, questionVersionId } = await setupShared(db);
      await expect(
        new MistakeService(db, f.auth).add(f.scope, { questionVersionId }),
      ).rejects.toMatchObject({ status: 404 });
    }));

  it("rejects another student's private question and attempt", async () =>
    withTestDb(async (db) => {
      const f = await catalogFixture(db);
      const invitation = await f.auth.invite(f.admin, { login: "other" });
      const other = await f.auth.activate({
        token: invitation.activationToken,
        password: "long-test-password",
      });
      const q = (
        await db.pool.query(
          "INSERT INTO questions(student_id,source_type) VALUES($1,'private_upload') RETURNING id",
          [other.studentId],
        )
      ).rows[0];
      const v = (
        await db.pool.query(
          "INSERT INTO question_versions(question_id,version_no,stem) VALUES($1,1,'私有题') RETURNING id",
          [q.id],
        )
      ).rows[0];
      const a = (
        await db.pool.query(
          "INSERT INTO attempts(student_id,question_version_id,request_key,answer) VALUES($1,$2,'other-attempt','1') RETURNING id",
          [other.studentId, v.id],
        )
      ).rows[0];
      const mistakes = new MistakeService(db, f.auth);
      await expect(
        mistakes.add(f.scope, { questionVersionId: v.id }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        mistakes.add(f.scope, { questionVersionId: v.id, attemptId: a.id }),
      ).rejects.toMatchObject({ status: 404 });
    }));

  it("rejects an attempt from another student on a shared question", async () =>
    withTestDb(async (db) => {
      const { f, task, questionVersionId } = await setupShared(db);
      const invitation = await f.auth.invite(f.admin, { login: "other2" });
      const other = await f.auth.activate({
        token: invitation.activationToken,
        password: "long-test-password",
      });
      const a = (
        await db.pool.query(
          "INSERT INTO attempts(student_id,task_id,question_version_id,request_key,answer) VALUES($1,$2,$3,'foreign','5') RETURNING id",
          [other.studentId, task.id, questionVersionId],
        )
      ).rows[0];
      await expect(
        new MistakeService(db, f.auth).add(f.scope, {
          questionVersionId,
          attemptId: a.id,
        }),
      ).rejects.toMatchObject({ status: 404 });
    }));
});
