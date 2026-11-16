import { createCanvas } from "@napi-rs/canvas";
import { describe, it, expect } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { AttemptService } from "../../apps/server/src/modules/learning/attempts.js";
import { AssessmentService } from "../../apps/server/src/modules/learning/assessments.js";
import { ConversationAttachmentService } from "../../apps/server/src/modules/conversations/attachments.js";
import { MistakeService } from "../../apps/server/src/modules/learning/mistakes.js";
import { ModelGateway } from "../../apps/server/src/agent/provider.js";
import { ModelBudget } from "../../apps/server/src/agent/model-budget.js";
import { inTransaction } from "../../packages/db/src/client.js";
import type { Database } from "../../packages/db/src/client.js";

type Fixture = Awaited<ReturnType<typeof catalogFixture>>;

function answerPng(tint: number): Buffer {
  const canvas = createCanvas(64, 48);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = `rgb(${tint},${(tint * 7) % 256},${(tint * 13) % 256})`;
  ctx.fillRect(0, 0, 64, 48);
  return canvas.toBuffer("image/png");
}

async function uploadAnswerImage(
  f: Fixture,
  conversationId: string,
  bytes: Buffer,
) {
  const grant = await f.uploads.create(f.scope.actor, {
    studentId: f.scope.studentId,
    purpose: "conversation_image",
    conversationId,
    name: "answer.png",
    contentType: "image/png",
    size: bytes.length,
  });
  f.store.put(grant.key, {
    size: bytes.length,
    contentType: "image/png",
    prefix: bytes,
  });
  await f.uploads.complete(f.scope.actor, grant.fileId);
  return { fileId: grant.fileId, bytes };
}

function imageVerifier(result: "correct" | "incorrect") {
  const faux = fauxProvider({
    models: [{ id: "vision", input: ["text", "image"] }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      JSON.stringify({
        correctness: result,
        evidenceSufficient: true,
        criteriaSatisfied: result === "correct",
        reason: "按图片中的过程判断",
      }),
    ),
  ]);
  return new ModelGateway(
    { models, model: faux.getModel() },
    new ModelBudget(),
  );
}

async function seedQuestion(
  db: Database,
  studentId: string | null,
  stem: string,
  sourceType = "practice",
) {
  const q = (
    await db.pool.query(
      "INSERT INTO questions(student_id,source_type) VALUES($1,$2) RETURNING id",
      [studentId, sourceType],
    )
  ).rows[0];
  const v = (
    await db.pool.query(
      "INSERT INTO question_versions(question_id,version_no,stem,reference_answer) VALUES($1,1,$2,'2') RETURNING id",
      [q.id, stem],
    )
  ).rows[0];
  await db.pool.query(
    "INSERT INTO question_references(question_version_id,answer,answer_type,requires_working,verification,evidence) VALUES($1,'2','number',false,'verified','{}')",
    [v.id],
  );
  return { questionId: q.id as string, versionId: v.id as string };
}

describe("mistake provenance", () => {
  it("derives learning provenance and is idempotent per question", async () =>
    withTestDb(async (db) => {
      const f = await catalogFixture(db);
      const task = await new TaskService(db, f.auth, f.catalog).create(
        f.scope,
        { kind: "daily_practice" },
      );
      const q = await seedQuestion(db, f.scope.studentId, "只填数值：1+1=?");
      await db.pool.query(
        "INSERT INTO task_items(task_id,question_version_id,position,role) VALUES($1,$2,0,'original')",
        [task.id, q.versionId],
      );
      const messages = new MessageService(db, f.auth);
      const msg = await messages.append(f.scope, {
        conversationId: task.conversationId,
        role: "user",
        content: "2",
      });
      const attempt = await new AttemptService(db, f.auth).submit(f.scope, {
        taskId: task.id,
        questionVersionId: q.versionId,
        messageVersionId: msg.versionId,
        answer: "2",
        requestKey: "provenance-1",
      });
      const mistakes = new MistakeService(db, f.auth);
      const saved = await mistakes.add(f.scope, {
        questionVersionId: q.versionId,
        attemptId: attempt.id,
      });
      expect(saved.originCategory).toBe("learning");
      expect(saved.originDetail).toBe("daily_practice");
      expect(saved.originalAttemptId).toBe(attempt.id);
      expect(saved.originQuestionVersionId).toBe(q.versionId);
      const duplicate = await mistakes.add(f.scope, {
        questionVersionId: q.versionId,
        attemptId: attempt.id,
      });
      expect(duplicate.id).toBe(saved.id);
      expect(duplicate.originCategory).toBe("learning");
    }));

  it("keeps uploaded provenance after a later evidence review with an image", async () =>
    withTestDb(async (db) => {
      const f = await catalogFixture(db);
      const q = await seedQuestion(
        db,
        f.scope.studentId,
        "只填数值：1+1=?",
        "material",
      );
      const mistakes = new MistakeService(db, f.auth);
      const saved = await mistakes.add(f.scope, {
        questionVersionId: q.versionId,
      });
      expect(saved.originCategory).toBe("uploaded");
      expect(saved.originDetail).toBe("material_import");
      expect(saved.originalAttemptId).toBeNull();

      const task = await new TaskService(db, f.auth, f.catalog).create(
        f.scope,
        { kind: "material_tutoring" },
      );
      await db.pool.query(
        "INSERT INTO task_items(task_id,question_version_id,position,role) VALUES($1,$2,0,'original')",
        [task.id, q.versionId],
      );
      const messages = new MessageService(db, f.auth);
      const msg = await messages.append(f.scope, {
        conversationId: task.conversationId,
        role: "user",
        content: "2",
      });
      const image = await uploadAnswerImage(
        f,
        task.conversationId,
        answerPng(140),
      );
      await inTransaction(db, (tx) =>
        new ConversationAttachmentService(db, f.auth, f.store).validateAndBind(
          tx,
          f.scope,
          task.conversationId,
          msg.versionId,
          [image.fileId],
        ),
      );
      const attempt = await new AttemptService(db, f.auth).submit(f.scope, {
        taskId: task.id,
        questionVersionId: q.versionId,
        messageVersionId: msg.versionId,
        answer: "2",
        requestKey: "uploaded-review",
      });
      const assessment = await new AssessmentService(
        db,
        f.auth,
        f.catalog,
        imageVerifier("correct"),
        f.store,
      ).submitCandidate(f.scope, {
        attemptId: attempt.id,
        correctness: "correct",
        reason: "图片过程与参考答案一致",
        referenceIds: [],
      });
      expect(assessment.verification).toBe("verified");
      await mistakes.applyAssessment(f.scope, assessment.id);
      const after = await mistakes.get(f.scope, saved.id);
      expect(after.originCategory).toBe("uploaded");
      expect(after.originDetail).toBe("material_import");
      expect(after.originQuestionVersionId).toBe(q.versionId);
      expect(after.originalAttemptId).toBeNull();
      expect(after.hasImageEvidence).toBe(true);
      expect(after.lifecycle).toBe("active");
    }));

  it("revokes an invalidated error and reactivates on a new valid error", async () =>
    withTestDb(async (db) => {
      const f = await catalogFixture(db);
      const task = await new TaskService(db, f.auth, f.catalog).create(
        f.scope,
        { kind: "daily_practice" },
      );
      const q = await seedQuestion(db, f.scope.studentId, "只填数值：1+1=?");
      await db.pool.query(
        "INSERT INTO task_items(task_id,question_version_id,position,role) VALUES($1,$2,0,'original')",
        [task.id, q.versionId],
      );
      const messages = new MessageService(db, f.auth);
      const assessments = new AssessmentService(db, f.auth, f.catalog);
      const mistakes = new MistakeService(db, f.auth);

      const msg = await messages.append(f.scope, {
        conversationId: task.conversationId,
        role: "user",
        content: "3",
      });
      const attempt = await new AttemptService(db, f.auth).submit(f.scope, {
        taskId: task.id,
        questionVersionId: q.versionId,
        messageVersionId: msg.versionId,
        answer: "3",
        requestKey: "revoke-1",
      });
      const incorrect = await assessments.submitCandidate(f.scope, {
        attemptId: attempt.id,
        correctness: "incorrect",
        reason: "数值不匹配",
        referenceIds: [],
      });
      expect(incorrect).toMatchObject({
        correctness: "incorrect",
        verification: "verified",
      });
      const saved = await mistakes.applyAssessment(f.scope, incorrect.id);
      expect(saved).toBeDefined();
      expect((await mistakes.get(f.scope, saved!.id)).lifecycle).toBe("active");

      await db.pool.query(
        "INSERT INTO evidence_invalidations(student_id,evidence_version_id,reason) VALUES($1,$2,'答案被更正')",
        [f.scope.studentId, msg.versionId],
      );
      const revoked = await mistakes.get(f.scope, saved!.id);
      expect(revoked.lifecycle).toBe("revoked");
      expect(
        (await mistakes.list(f.scope, { includeArchived: false })).some(
          (m) => m.id === saved!.id,
        ),
      ).toBe(false);

      const msg2 = await messages.append(f.scope, {
        conversationId: task.conversationId,
        role: "user",
        content: "4",
      });
      const attempt2 = await new AttemptService(db, f.auth).submit(f.scope, {
        taskId: task.id,
        questionVersionId: q.versionId,
        messageVersionId: msg2.versionId,
        answer: "4",
        requestKey: "revoke-2",
      });
      const incorrect2 = await assessments.submitCandidate(f.scope, {
        attemptId: attempt2.id,
        correctness: "incorrect",
        reason: "仍然不匹配",
        referenceIds: [],
      });
      await mistakes.applyAssessment(f.scope, incorrect2.id);
      const reactivated = await mistakes.get(f.scope, saved!.id);
      expect(reactivated.lifecycle).toBe("active");
    }));
});

describe("mistake list pagination", () => {
  it("pages by origin, keeps origin counts and hides revoked by default", async () =>
    withTestDb(async (db) => {
      const f = await catalogFixture(db);
      const rows: { id: string; origin: string; lifecycle: string }[] = [];
      for (const [index, origin] of [
        "learning",
        "learning",
        "uploaded",
        "learning",
      ].entries()) {
        const q = await seedQuestion(
          db,
          f.scope.studentId,
          `分页题 ${index}`,
        );
        const lifecycle = index === 2 ? "active" : index === 3 ? "revoked" : "active";
        const inserted = (
          await db.pool.query(
            "INSERT INTO student_mistakes(student_id,question_id,origin_category,origin_detail,lifecycle) VALUES($1,$2,$3,$4,$5) RETURNING id",
            [
              f.scope.studentId,
              q.questionId,
              origin,
              origin === "uploaded" ? "material_import" : "daily_practice",
              lifecycle,
            ],
          )
        ).rows[0];
        rows.push({ id: inserted.id, origin, lifecycle });
      }
      const mistakes = new MistakeService(db, f.auth);
      const first = await mistakes.listPage(f.scope, {
        includeArchived: false,
        page: 1,
        pageSize: 2,
      });
      expect(first.total).toBe(3);
      expect(first.items).toHaveLength(2);
      expect(first.originCounts).toEqual({
        all: 3,
        uploaded: 1,
        learning: 2,
        unknown: 0,
      });
      const learning = await mistakes.listPage(f.scope, {
        includeArchived: false,
        origin: "learning",
        page: 1,
        pageSize: 10,
      });
      expect(learning.total).toBe(2);
      expect(learning.items).toHaveLength(2);
      expect(learning.originCounts.uploaded).toBe(1);
      expect(learning.originCounts.learning).toBe(2);
      const second = await mistakes.listPage(f.scope, {
        includeArchived: false,
        origin: "learning",
        page: 2,
        pageSize: 1,
      });
      expect(second.items).toHaveLength(1);
      expect(second.total).toBe(2);
      const archived = await mistakes.listPage(f.scope, {
        includeArchived: true,
        page: 1,
        pageSize: 10,
      });
      expect(archived.total).toBe(4);
      expect(archived.originCounts.all).toBe(4);
    }));
});
