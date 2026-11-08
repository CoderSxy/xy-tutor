import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { AttemptService } from "../../apps/server/src/modules/learning/attempts.js";
import { AssessmentService } from "../../apps/server/src/modules/learning/assessments.js";
import { MistakeService } from "../../apps/server/src/modules/learning/mistakes.js";
it("applies assessment idempotently and revokes projection supported by edited evidence", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "加法");
    const tasks = new TaskService(db, f.auth, f.catalog);
    const t = await tasks.create(f.scope, {
      revisionId: r.id,
      kind: "mistake_review",
    });
    const q = await tasks.addQuestion(f.scope, t.id, {
      stem: "只填数值：1+1=?",
      referenceAnswer: "2",
      role: "original",
    });
    await db.pool.query(
      "INSERT INTO question_references(question_version_id,answer,answer_type,requires_working,verification,evidence) VALUES($1,'2','number',false,'verified','{}')",
      [q.questionVersionId],
    );
    const s = new MistakeService(db, f.auth);
    const mistake = await s.add(f.scope, {
      questionVersionId: q.questionVersionId,
    });
    const messages = new MessageService(db, f.auth);
    const msg = await messages.append(f.scope, {
      conversationId: t.conversationId,
      role: "user",
      content: "2",
    });
    const attempt = await new AttemptService(db, f.auth).submit(f.scope, {
      taskId: t.id,
      questionVersionId: q.questionVersionId,
      messageVersionId: msg.versionId,
      answer: "2",
      requestKey: "answer",
    });
    const assessment = await new AssessmentService(
      db,
      f.auth,
      f.catalog,
    ).submitCandidate(f.scope, {
      attemptId: attempt.id,
      correctness: "correct",
      reason: "数值匹配",
      referenceIds: [],
    });
    await s.applyAssessment(f.scope, assessment.id);
    await s.applyAssessment(f.scope, assessment.id);
    expect((await s.get(f.scope, mistake.id)).status).toBe(
      "corrected_pending_practice",
    );
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM mistake_state_events WHERE assessment_id=$1",
          [assessment.id],
        )
      ).rows[0].n,
    ).toBe(1);
    await messages.edit(f.scope, {
      messageId: msg.id,
      expectedVersion: 1,
      content: "我还不会",
    });
    expect((await s.get(f.scope, mistake.id)).status).not.toBe(
      "corrected_pending_practice",
    );
    expect((await s.history(f.scope, mistake.id)).length).toBeGreaterThan(1);
  }));
it("keeps delayed variant evidence and revokes mastery when its message is corrected", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "加法");
    const tasks = new TaskService(db, f.auth, f.catalog);
    const t = await tasks.create(f.scope, {
      revisionId: r.id,
      kind: "mistake_review",
    });
    const mistakes = new MistakeService(db, f.auth);
    const messages = new MessageService(db, f.auth);
    const assessments = new AssessmentService(db, f.auth, f.catalog);
    let origin = "";
    let originVersion = "";
    let lastMessage: { id: string } | undefined;
    for (let n = 0; n < 3; n++) {
      const q = await tasks.addQuestion(f.scope, t.id, {
        stem: `只填数值：${n + 1}+${n + 1}=?`,
        referenceAnswer: String((n + 1) * 2),
        role: n === 0 ? "original" : "variant",
      });
      const qid = (
        await db.pool.query(
          "SELECT question_id FROM question_versions WHERE id=$1",
          [q.questionVersionId],
        )
      ).rows[0].question_id;
      if (n === 0) {
        origin = qid;
        originVersion = q.questionVersionId;
        await mistakes.add(f.scope, { questionVersionId: q.questionVersionId });
      } else
        await db.pool.query(
          "INSERT INTO question_relations(variant_question_id,origin_question_id,origin_question_version_id,knowledge_point,verified,evidence) VALUES($1,$2,$3,'加法',true,$4)",
          [qid, origin, originVersion, JSON.stringify({ fixture: true })],
        );
      await db.pool.query(
        "INSERT INTO question_references(question_version_id,answer,answer_type,requires_working,verification,evidence) VALUES($1,$2,'number',false,'verified','{}')",
        [q.questionVersionId, String((n + 1) * 2)],
      );
      const m = await messages.append(f.scope, {
        conversationId: t.conversationId,
        role: "user",
        content: String((n + 1) * 2),
      });
      lastMessage = m;
      const a = await new AttemptService(db, f.auth).submit(f.scope, {
        taskId: t.id,
        questionVersionId: q.questionVersionId,
        messageVersionId: m.versionId,
        answer: String((n + 1) * 2),
        requestKey: `variant-${n}`,
      });
      await db.pool.query("UPDATE attempts SET created_at=$2 WHERE id=$1", [
        a.id,
        new Date(Date.UTC(2026, 10, 1 + n * 2)),
      ]);
      const assessment = await assessments.submitCandidate(f.scope, {
        attemptId: a.id,
        correctness: "correct",
        reason: "合成数值核验",
        referenceIds: [],
      });
      await mistakes.applyAssessment(f.scope, assessment.id);
      const rows = await mistakes.list(f.scope, { includeArchived: true });
      expect(rows[0]!.status).toBe(
        [
          "corrected_pending_practice",
          "consolidated_pending_review",
          "mastered",
        ][n],
      );
    }
    const m = (
      await db.pool.query(
        "SELECT id FROM student_mistakes WHERE question_id=$1",
        [origin],
      )
    ).rows[0];
    expect((await mistakes.get(f.scope, m.id)).status).toBe("mastered");
    await messages.edit(f.scope, {
      messageId: lastMessage!.id,
      expectedVersion: 1,
      content: "更正：我用了提示",
    });
    expect((await mistakes.get(f.scope, m.id)).status).toBe(
      "consolidated_pending_review",
    );
    expect(
      (await mistakes.history(f.scope, m.id)).some(
        (e) => e.toState === "mastered",
      ),
    ).toBe(true);
  }));
