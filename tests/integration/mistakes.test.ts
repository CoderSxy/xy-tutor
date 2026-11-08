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
