import { createCanvas } from "@napi-rs/canvas";
import { it, expect } from "vitest";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { SummaryService } from "../../apps/server/src/modules/learning/summaries.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { AttemptService } from "../../apps/server/src/modules/learning/attempts.js";
import { AssessmentService } from "../../apps/server/src/modules/learning/assessments.js";
import { ConversationAttachmentService } from "../../apps/server/src/modules/conversations/attachments.js";
import { ModelGateway } from "../../apps/server/src/agent/provider.js";
import { ModelBudget } from "../../apps/server/src/agent/model-budget.js";
import { inTransaction } from "../../packages/db/src/client.js";

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

function imageVerifier() {
  const faux = fauxProvider({
    models: [{ id: "vision", input: ["text", "image"] }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      JSON.stringify({
        correctness: "correct",
        evidenceSufficient: true,
        criteriaSatisfied: true,
        reason: "图片过程与答案一致",
      }),
    ),
  ]);
  return new ModelGateway(
    { models, model: faux.getModel() },
    new ModelBudget(),
  );
}
it("commits task completion and its summary job together and keeps history if generation fails", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "分数");
    const tasks = new TaskService(db, f.auth, f.catalog);
    const t = await tasks.create(f.scope, {
      revisionId: r.id,
      kind: "free_question",
    });
    await tasks.transition(f.scope, {
      taskId: t.id,
      expectedVersion: t.version,
      status: "completed",
    });
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM jobs WHERE kind='learning.summary'",
        )
      ).rows[0].n,
    ).toBe(1);
    const summaries = new SummaryService(db, f.auth);
    await summaries.generate({ taskId: t.id });
    const result = await summaries.latest(f.scope, t.id);
    expect(result?.content.attemptCount).toBe(0);
    expect((await tasks.resume(f.scope, t.id)).status).toBe("completed");
  }));
it("does not reuse a summary after its message evidence is edited", async () =>
  withTestDb(async (db) => {
    const { MessageService } =
      await import("../../apps/server/src/modules/conversations/messages.js");
    const { AttemptService } =
      await import("../../apps/server/src/modules/learning/attempts.js");
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "加法");
    const tasks = new TaskService(db, f.auth, f.catalog);
    const t = await tasks.create(f.scope, {
      revisionId: r.id,
      kind: "free_question",
    });
    const q = await tasks.addQuestion(f.scope, t.id, {
      stem: "1+1=?",
      role: "original",
    });
    const ms = new MessageService(db, f.auth);
    const m = await ms.append(f.scope, {
      conversationId: t.conversationId,
      role: "user",
      content: "2",
    });
    await new AttemptService(db, f.auth).submit(f.scope, {
      taskId: t.id,
      questionVersionId: q.questionVersionId,
      messageVersionId: m.versionId,
      answer: "2",
      requestKey: "one",
    });
    await tasks.transition(f.scope, {
      taskId: t.id,
      expectedVersion: t.version,
      status: "completed",
    });
    const s = new SummaryService(db, f.auth);
    await s.generate({ taskId: t.id });
    expect((await s.latest(f.scope, t.id))?.content.attemptCount).toBe(1);
    await ms.edit(f.scope, {
      messageId: m.id,
      expectedVersion: 1,
      content: "不确定",
    });
    expect(await s.latest(f.scope, t.id)).toMatchObject({
      source: "current_facts",
      content: { attemptCount: 0 },
    });
  }));
it("summary keeps image evidence ids and never stores image bytes", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "加法");
    const tasks = new TaskService(db, f.auth, f.catalog);
    const t = await tasks.create(f.scope, {
      revisionId: r.id,
      kind: "free_question",
    });
    const q = await tasks.addQuestion(f.scope, t.id, {
      stem: "1+1=?",
      role: "original",
    });
    await db.pool.query(
      "INSERT INTO question_references(question_version_id,answer,answer_type,requires_working,verification,evidence) VALUES($1,'2','number',false,'verified','{}')",
      [q.questionVersionId],
    );
    const ms = new MessageService(db, f.auth);
    const m = await ms.append(f.scope, {
      conversationId: t.conversationId,
      role: "user",
      content: "2",
    });
    const image = await uploadAnswerImage(f, t.conversationId, answerPng(90));
    await inTransaction(db, (tx) =>
      new ConversationAttachmentService(db, f.auth, f.store).validateAndBind(
        tx,
        f.scope,
        t.conversationId,
        m.versionId,
        [image.fileId],
      ),
    );
    const attempt = await new AttemptService(db, f.auth).submit(f.scope, {
      taskId: t.id,
      questionVersionId: q.questionVersionId,
      messageVersionId: m.versionId,
      answer: "2",
      requestKey: "image-summary",
    });
    const assessment = await new AssessmentService(
      db,
      f.auth,
      f.catalog,
      imageVerifier(),
      f.store,
    ).submitCandidate(f.scope, {
      attemptId: attempt.id,
      correctness: "correct",
      reason: "图片过程与答案一致",
      referenceIds: [],
    });
    await tasks.transition(f.scope, {
      taskId: t.id,
      expectedVersion: t.version,
      status: "completed",
    });
    const s = new SummaryService(db, f.auth);
    await s.generate({ taskId: t.id });
    const result = await s.latest(f.scope, t.id);
    expect(result).toMatchObject({
      source: "saved",
      content: { attemptCount: 1, verifiedCorrect: 1 },
    });
    expect(
      result?.content.evidence.some(
        (e) => e.kind === "message_version" && e.id === m.versionId,
      ),
    ).toBe(true);
    expect(
      result?.content.evidence.some(
        (e) => e.kind === "assessment" && e.id === assessment.id,
      ),
    ).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(image.bytes.toString("base64"));
    expect(serialized).not.toContain("download");
  }));
