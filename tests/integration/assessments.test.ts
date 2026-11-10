import { createCanvas } from "@napi-rs/canvas";
import { it, expect } from "vitest";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { AttemptService } from "../../apps/server/src/modules/learning/attempts.js";
import { AssessmentService } from "../../apps/server/src/modules/learning/assessments.js";
import { PracticeService } from "../../apps/server/src/modules/learning/practice.js";
import { MistakeService } from "../../apps/server/src/modules/learning/mistakes.js";
import { ConversationAttachmentService } from "../../apps/server/src/modules/conversations/attachments.js";
import { ImageEvidenceReader } from "../../apps/server/src/modules/conversations/attachments.js";
import { buildContext } from "../../apps/server/src/agent/context.js";
import { inTransaction } from "../../packages/db/src/client.js";
import { ModelGateway } from "../../apps/server/src/agent/provider.js";
import { ModelBudget } from "../../apps/server/src/agent/model-budget.js";

type Fixture = Awaited<ReturnType<typeof catalogFixture>>;
type ImageBlock = { type: "image"; data: string; mimeType: string };

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
  const sealed = (
    await f.db.pool.query("SELECT object_key FROM files WHERE id=$1", [
      grant.fileId,
    ])
  ).rows[0].object_key as string;
  return { fileId: grant.fileId, key: sealed, bytes };
}

async function appendImageAttempt(
  f: Fixture,
  task: { id: string; conversationId: string },
  questionVersionId: string,
  input: { content: string; requestKey: string; tint?: number },
) {
  const messages = new MessageService(f.db, f.auth);
  const message = await messages.append(f.scope, {
    conversationId: task.conversationId,
    role: "user",
    content: input.content,
  });
  const image = await uploadAnswerImage(
    f,
    task.conversationId,
    answerPng(input.tint ?? 33),
  );
  await inTransaction(f.db, (tx) =>
    new ConversationAttachmentService(f.db, f.auth, f.store).validateAndBind(
      tx,
      f.scope,
      task.conversationId,
      message.versionId,
      [image.fileId],
    ),
  );
  const attempt = await new AttemptService(f.db, f.auth).submit(f.scope, {
    taskId: task.id,
    questionVersionId,
    messageVersionId: message.versionId,
    answer: input.content,
    requestKey: input.requestKey,
  });
  return { message, image, attempt };
}

function imageBlocks(messages: Message[]): ImageBlock[] {
  const blocks: ImageBlock[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content)
      if (block.type === "image") blocks.push(block);
  }
  return blocks;
}

function pickImages(
  content: readonly ({ type: "text"; text: string } | ImageBlock)[],
): ImageBlock[] {
  return content.filter((block): block is ImageBlock => block.type === "image");
}

async function insertVerifiedReference(
  f: Fixture,
  questionVersionId: string,
  answer: string,
  requiresWorking = false,
) {
  await f.db.pool.query(
    "INSERT INTO question_references(question_version_id,answer,answer_type,requires_working,verification,evidence) VALUES($1,$2,'number',$3,'verified','{}')",
    [questionVersionId, answer, requiresWorking],
  );
}
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
it("image_work_is_checked_even_when_text_answer_matches", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "分数");
    const tasks = new TaskService(db, f.auth, f.catalog);
    const t = await tasks.create(f.scope, {
      revisionId: r.id,
      kind: "daily_practice",
    });
    const q = await tasks.addQuestion(f.scope, t.id, {
      stem: "只填数值：1+1=?",
      referenceAnswer: "3",
      role: "original",
    });
    await insertVerifiedReference(f, q.questionVersionId, "3");
    const { attempt, image } = await appendImageAttempt(
      f,
      t,
      q.questionVersionId,
      { content: "3", requestKey: "image-work", tint: 44 },
    );
    const faux = fauxProvider({
      models: [{ id: "vision", input: ["text", "image"] }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    let seen: Message[] = [];
    faux.setResponses([
      (context) => {
        seen = context.messages;
        return fauxAssistantMessage(
          JSON.stringify({
            correctness: "incorrect",
            evidenceSufficient: true,
            criteriaSatisfied: false,
            reason: "图中过程错误",
          }),
        );
      },
    ]);
    const gateway = new ModelGateway(
      { models, model: faux.getModel() },
      new ModelBudget(),
    );
    const result = await new AssessmentService(
      db,
      f.auth,
      f.catalog,
      gateway,
      f.store,
    ).submitCandidate(f.scope, {
      attemptId: attempt.id,
      correctness: "correct",
      reason: "最终数值为 3",
      referenceIds: [],
    });
    expect(result).toMatchObject({
      correctness: "uncertain",
      verification: "pending",
    });
    expect(faux.state.callCount).toBe(1);
    expect(imageBlocks(seen).map((block) => block.data)).toEqual([
      image.bytes.toString("base64"),
    ]);
    const payload = seen
      .flatMap((message) =>
        typeof message.content === "string"
          ? [message.content]
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text),
      )
      .map((text) => {
        try {
          return JSON.parse(text) as { hasImageEvidence?: boolean };
        } catch {
          return {};
        }
      })
      .find((value) => value.hasImageEvidence === true);
    expect(payload).toBeDefined();
    const saved = (
      await db.pool.query(
        "SELECT correctness,verification,evidence FROM assessments WHERE id=$1",
        [result.id],
      )
    ).rows[0];
    expect(saved.correctness).toBe("uncertain");
    expect(saved.verification).toBe("pending");
    expect(saved.evidence.imageEvidence).toBe(true);
  }));
it("unreadable_image_remains_pending", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "分数");
    const tasks = new TaskService(db, f.auth, f.catalog);
    const t = await tasks.create(f.scope, {
      revisionId: r.id,
      kind: "daily_practice",
    });
    const q = await tasks.addQuestion(f.scope, t.id, {
      stem: "只填数值：1+1=?",
      referenceAnswer: "3",
      role: "original",
    });
    await insertVerifiedReference(f, q.questionVersionId, "3");
    const { attempt, image } = await appendImageAttempt(
      f,
      t,
      q.questionVersionId,
      { content: "3", requestKey: "broken-image", tint: 66 },
    );
    const read = f.store.read.bind(f.store);
    f.store.read = async (key) => {
      if (key === image.key) throw Error("object missing");
      return read(key);
    };
    const faux = fauxProvider({
      models: [{ id: "vision", input: ["text", "image"] }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("不应被调用")]);
    const gateway = new ModelGateway(
      { models, model: faux.getModel() },
      new ModelBudget(),
    );
    const result = await new AssessmentService(
      db,
      f.auth,
      f.catalog,
      gateway,
      f.store,
    ).submitCandidate(f.scope, {
      attemptId: attempt.id,
      correctness: "correct",
      reason: "文字答案正确",
      referenceIds: [],
    });
    expect(result).toMatchObject({
      correctness: "uncertain",
      verification: "pending",
    });
    expect(faux.state.callCount).toBe(0);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM assessments WHERE attempt_id=$1 AND correctness='incorrect'",
          [attempt.id],
        )
      ).rows[0].n,
    ).toBe(0);
    const mistakes = new MistakeService(db, f.auth);
    const mistake = await mistakes.add(f.scope, {
      questionVersionId: q.questionVersionId,
    });
    await mistakes.applyAssessment(f.scope, result.id);
    expect((await mistakes.get(f.scope, mistake.id)).status).toBe(
      "pending_correction",
    );
  }));
it("main_agent_and_independent_verification_read_the_same_image_version", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "分数");
    const tasks = new TaskService(db, f.auth, f.catalog);
    const t = await tasks.create(f.scope, {
      revisionId: r.id,
      kind: "daily_practice",
    });
    const q = await tasks.addQuestion(f.scope, t.id, {
      stem: "只填数值：1+1=?",
      referenceAnswer: "3",
      role: "original",
    });
    await insertVerifiedReference(f, q.questionVersionId, "3");
    const { attempt, image } = await appendImageAttempt(
      f,
      t,
      q.questionVersionId,
      { content: "3", requestKey: "same-version", tint: 88 },
    );
    const context = await buildContext(
      db,
      f.auth,
      f.catalog,
      f.scope,
      t.conversationId,
      8000,
      {
        reader: new ImageEvidenceReader(db, f.store),
        inputVersionId: attempt.messageVersionId,
        signal: new AbortController().signal,
      },
    );
    expect(context.inputMatched).toBe(true);
    expect(pickImages(context.inputContent ?? [])).toHaveLength(1);
    const mainAgentImage = pickImages(context.inputContent ?? [])[0]!;
    const faux = fauxProvider({
      models: [{ id: "vision", input: ["text", "image"] }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    let seen: Message[] = [];
    faux.setResponses([
      (ctx) => {
        seen = ctx.messages;
        return fauxAssistantMessage(
          JSON.stringify({
            correctness: "correct",
            evidenceSufficient: true,
            criteriaSatisfied: true,
            reason: "过程与答案一致",
          }),
        );
      },
    ]);
    const gateway = new ModelGateway(
      { models, model: faux.getModel() },
      new ModelBudget(),
    );
    await new AssessmentService(
      db,
      f.auth,
      f.catalog,
      gateway,
      f.store,
    ).submitCandidate(f.scope, {
      attemptId: attempt.id,
      correctness: "correct",
      reason: "与图中的过程一致",
      referenceIds: [],
    });
    const independentImage = imageBlocks(seen)[0]!;
    expect(mainAgentImage).toMatchObject({
      data: image.bytes.toString("base64"),
      mimeType: "image/png",
    });
    expect(independentImage).toMatchObject({
      data: image.bytes.toString("base64"),
      mimeType: "image/png",
    });
  }));
