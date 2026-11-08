import { it, expect } from "vitest";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { AttemptService } from "../../apps/server/src/modules/learning/attempts.js";
import { AssessmentService } from "../../apps/server/src/modules/learning/assessments.js";
import { PracticeService } from "../../apps/server/src/modules/learning/practice.js";
import { ModelGateway } from "../../apps/server/src/agent/provider.js";
import { ModelBudget } from "../../apps/server/src/agent/model-budget.js";
it("derives hint dependency from recorded evidence and ignores untrusted verification flags", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "分数");
    const tasks = new TaskService(db, f.auth, f.catalog);
    const t = await tasks.create(f.scope, {
      revisionId: r.id,
      kind: "daily_practice",
    });
    const q = await tasks.addQuestion(f.scope, t.id, {
      stem: "只填数值：1/2+1/2=?",
      referenceAnswer: "1",
      role: "original",
    });
    await db.pool.query(
      "INSERT INTO question_references(question_version_id,answer,answer_type,requires_working,verification,evidence) VALUES($1,'1','number',false,'verified','{}')",
      [q.questionVersionId],
    );
    const messages = new MessageService(db, f.auth);
    const hint = await messages.append(f.scope, {
      conversationId: t.conversationId,
      role: "assistant",
      content: "分母相同，分子相加",
    });
    await db.pool.query(
      "INSERT INTO hints(task_id,question_version_id,message_version_id,level,displayed_at) VALUES($1,$2,$3,'guided',now()-interval '1 second')",
      [t.id, q.questionVersionId, hint.versionId],
    );
    const reply = await messages.append(f.scope, {
      conversationId: t.conversationId,
      role: "user",
      content: "1",
    });
    const a = await new AttemptService(db, f.auth).submit(f.scope, {
      taskId: t.id,
      questionVersionId: q.questionVersionId,
      messageVersionId: reply.versionId,
      answer: "1",
      requestKey: "answer",
    });
    const s = new AssessmentService(db, f.auth, f.catalog);
    const input = {
      attemptId: a.id,
      correctness: "correct",
      reason: "最终数值一致",
      referenceIds: [],
    };
    expect(await s.submitCandidate(f.scope, input)).toMatchObject({
      correctness: "correct",
      verification: "verified",
      hintDependency: "guided",
    });
    await expect(
      s.submitCandidate(f.scope, { ...input, verification: "verified" }),
    ).rejects.toThrow();
  }));
it("does not publish practice after a mismatched reference and one replacement attempt", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "加法");
    const tasks = new TaskService(db, f.auth, f.catalog);
    const t = await tasks.create(f.scope, {
      revisionId: r.id,
      kind: "daily_practice",
    });
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        JSON.stringify({
          referenceAnswer: "3",
          answerType: "number",
          requiresWorking: false,
          reason: "不一致",
        }),
      ),
      fauxAssistantMessage(
        JSON.stringify({
          stem: "只填数值：2+2=?",
          referenceAnswer: "4",
          knowledgePoint: "加法",
          role: "original",
          answerType: "number",
          requiresWorking: false,
        }),
      ),
      fauxAssistantMessage(
        JSON.stringify({
          referenceAnswer: "5",
          answerType: "number",
          requiresWorking: false,
          reason: "不一致",
        }),
      ),
    ]);
    const service = new PracticeService(
      db,
      tasks,
      new ModelGateway({ models, model: faux.getModel() }, new ModelBudget()),
    );
    expect(
      await service.propose(f.scope, t.id, {
        stem: "只填数值：1+1=?",
        referenceAnswer: "2",
        knowledgePoint: "加法",
        role: "original",
        answerType: "number",
        requiresWorking: false,
      }),
    ).toMatchObject({ status: "pending" });
    expect(await tasks.items(f.scope, t.id)).toEqual([]);
    expect(faux.state.callCount).toBe(3);
  }));
