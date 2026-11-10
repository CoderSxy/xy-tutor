import { createCanvas } from "@napi-rs/canvas";
import { it, expect } from "vitest";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { RunService } from "../../apps/server/src/modules/conversations/runs.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { ConversationAttachmentService } from "../../apps/server/src/modules/conversations/attachments.js";
import { buildContext } from "../../apps/server/src/agent/context.js";
import { ImageEvidenceReader } from "../../apps/server/src/modules/conversations/attachments.js";
import { inTransaction } from "../../packages/db/src/client.js";
import type { Database } from "../../packages/db/src/client.js";
import { ModelGateway } from "../../apps/server/src/agent/provider.js";
import { ModelBudget } from "../../apps/server/src/agent/model-budget.js";
import { BootstrapService } from "../../apps/server/src/agent/bootstrap.js";
import { TutorExecutor } from "../../apps/server/src/agent/tutor.js";

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
  const sealed = (
    await f.db.pool.query("SELECT object_key FROM files WHERE id=$1", [
      grant.fileId,
    ])
  ).rows[0].object_key as string;
  return { fileId: grant.fileId, key: sealed, bytes };
}

async function appendHistoryImage(
  f: Fixture,
  conversationId: string,
  bytes: Buffer,
  content: string,
  minutesAgo: number,
) {
  const message = await new MessageService(f.db, f.auth).append(f.scope, {
    conversationId,
    role: "user",
    content,
  });
  const image = await uploadAnswerImage(f, conversationId, bytes);
  await inTransaction(f.db, (tx) =>
    new ConversationAttachmentService(f.db, f.auth, f.store).validateAndBind(
      tx,
      f.scope,
      conversationId,
      message.versionId,
      [image.fileId],
    ),
  );
  await f.db.pool.query(
    "UPDATE messages SET created_at=now() - ($2 || ' minutes')::interval WHERE id=$1",
    [message.id, minutesAgo],
  );
  return image;
}

type ImageBlock = { type: "image"; data: string; mimeType: string };

function imageBlocks(messages: Message[]): ImageBlock[] {
  const blocks: ImageBlock[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content)
      if (block.type === "image") blocks.push(block);
  }
  return blocks;
}

async function knowledgeItem(
  db: Database,
  actorId: string,
  input: { title: string; summary: string; status?: string },
) {
  const batchId = (
    await db.pool.query<{ id: string }>(
      "INSERT INTO knowledge_batches(actor_id,text_content) VALUES($1,'知识点') RETURNING id",
      [actorId],
    )
  ).rows[0]!.id;
  const runId = (
    await db.pool.query<{ id: string }>(
      "INSERT INTO knowledge_parse_runs(batch_id,status,model,completed_at) VALUES($1,'succeeded','fake',now()) RETURNING id",
      [batchId],
    )
  ).rows[0]!.id;
  const status = input.status ?? "published";
  return (
    await db.pool.query<{ id: string }>(
      `INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status,published_at)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        batchId,
        runId,
        input.title,
        input.summary,
        status,
        status === "published" ? new Date() : null,
      ],
    )
  ).rows[0]!.id;
}
it("opens once per entry and retains usable actions without a configured model", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数");
    const runs = new RunService(db, f.auth);
    const b = new BootstrapService(db, f.auth, f.catalog, runs);
    const input = { revisionId: revision.id, entryKey: "same-entry" };
    const first = await b.open(f.scope, input);
    const again = await b.open(f.scope, input);
    expect(first.conversationId).toBe(again.conversationId);
    expect(first.actions).toHaveLength(6);
    expect(first.runId).toBeUndefined();
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM conversations"))
        .rows[0].n,
    ).toBe(1);
  }));
it("persists pi public replies and streaming events from a real agent loop", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "通分");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: revision.id,
      kind: "free_question",
    });
    const runs = new RunService(db, f.auth);
    const { runId } = await runs.submit(f.scope, {
      conversationId: task.conversationId,
      requestKey: "one",
      message: "你好",
    });
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("最近学到哪一章了？")]);
    const gateway = new ModelGateway(
      { models, model: faux.getModel() },
      new ModelBudget(),
    );
    await new TutorExecutor(db, f.auth, f.catalog, runs, gateway).execute(
      runId,
      new AbortController().signal,
    );
    const status = await runs.get(f.scope, runId);
    expect(status.content).toBe("最近学到哪一章了？");
    const events = await runs.events.readAfter(f.scope, runId);
    expect(events.some((e) => e.type === "message_completed")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("thinking");
  }));
it("rejects attempts to override tool scope and retains question and hint context", async () =>
  withTestDb(async (db) => {
    const { createTeachingTools } =
      await import("../../apps/server/src/agent/tools.js");
    const { buildContext } =
      await import("../../apps/server/src/agent/context.js");
    const { MessageService } =
      await import("../../apps/server/src/modules/conversations/messages.js");
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "分数");
    const tasks = new TaskService(db, f.auth, f.catalog);
    const t = await tasks.create(f.scope, {
      revisionId: r.id,
      kind: "knowledge_consolidation",
    });
    const q = await tasks.addQuestion(f.scope, t.id, {
      stem: "1/2+1/2=?",
      role: "diagnostic",
    });
    const m = await new MessageService(db, f.auth).append(f.scope, {
      conversationId: t.conversationId,
      role: "assistant",
      content: "先看分母是否相同",
    });
    await db.pool.query(
      "INSERT INTO hints(task_id,question_version_id,message_version_id,level) VALUES($1,$2,$3,'guided')",
      [t.id, q.questionVersionId, m.versionId],
    );
    const runs = new RunService(db, f.auth);
    const { runId } = await runs.submit(f.scope, {
      conversationId: t.conversationId,
      requestKey: "one",
      message: "不会",
    });
    const tools = createTeachingTools(
      { scope: f.scope, taskId: t.id, revisionId: r.id, runId },
      db,
      f.catalog,
    );
    const tool = tools.find((x) => x.name === "search_knowledge")!;
    const result = await tool.execute("call", {
      keywords: "分数",
      studentId: crypto.randomUUID(),
    });
    expect(result.isError).toBe(true);
    const context = await buildContext(
      db,
      f.auth,
      f.catalog,
      f.scope,
      t.conversationId,
      8000,
    );
    expect(context.currentQuestionVersionId).toBe(q.questionVersionId);
    expect(context.systemContext).toContain("先看分母是否相同");
    expect(context.systemContext).toContain("未知");
  }));
it("retrieves only published knowledge and reports insufficient evidence", async () =>
  withTestDb(async (db) => {
    const { createTeachingTools } =
      await import("../../apps/server/src/agent/tools.js");
    const f = await catalogFixture(db);
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      kind: "free_question",
    });
    const runs = new RunService(db, f.auth);
    const { runId } = await runs.submit(f.scope, {
      conversationId: task.conversationId,
      requestKey: "knowledge-search",
      message: "分数怎么通分",
    });
    const published = await knowledgeItem(db, f.admin.userId, {
      title: "异分母分数加法",
      summary: "先通分再相加",
    });
    await knowledgeItem(db, f.admin.userId, {
      title: "分数草稿",
      summary: "未确认的通分说明",
      status: "pending_review",
    });
    await knowledgeItem(db, f.admin.userId, {
      title: "分数废弃",
      summary: "已丢弃的通分说明",
      status: "discarded",
    });
    const tools = createTeachingTools(
      { scope: f.scope, taskId: task.id, runId },
      db,
      f.catalog,
    );
    const tool = tools.find((x) => x.name === "search_knowledge")!;
    const found = await tool.execute("call", { keywords: "分数" });
    expect(found.isError).not.toBe(true);
    expect(found.details).toEqual({
      status: "found",
      items: [
        {
          id: published,
          title: "异分母分数加法",
          summary: "先通分再相加",
        },
      ],
    });
    const missing = await tool.execute("call", { keywords: "三角形" });
    expect(missing.details).toEqual({
      status: "insufficient_evidence",
      items: [],
    });
  }));
it("describes knowledge retrieval instead of textbook metadata", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      kind: "free_question",
    });
    const context = await buildContext(
      db,
      f.auth,
      f.catalog,
      f.scope,
      task.conversationId,
      8000,
    );
    expect(context.revisionId).toBeUndefined();
    const payload = JSON.parse(context.systemContext);
    expect(payload).not.toHaveProperty("教材");
    expect(payload).not.toHaveProperty("年级");
    expect(payload).not.toHaveProperty("科目");
    expect(payload.知识点检索说明).toContain("search_knowledge");
  }));
it("runs a tutoring turn without a textbook binding", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      kind: "free_question",
    });
    const runs = new RunService(db, f.auth);
    const { runId } = await runs.submit(f.scope, {
      conversationId: task.conversationId,
      requestKey: "unbound-run",
      message: "今天学什么",
    });
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("今天想从哪里开始？")]);
    const gateway = new ModelGateway(
      { models, model: faux.getModel() },
      new ModelBudget(),
    );
    await new TutorExecutor(db, f.auth, f.catalog, runs, gateway).execute(
      runId,
      new AbortController().signal,
    );
    expect((await runs.get(f.scope, runId)).content).toBe(
      "今天想从哪里开始？",
    );
  }));
it("stops tool loops after eight model requests", async () =>
  withTestDb(async (db) => {
    const { fauxToolCall } = await import("@earendil-works/pi-ai");
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "分数");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: r.id,
      kind: "free_question",
    });
    const runs = new RunService(db, f.auth);
    const { runId } = await runs.submit(f.scope, {
      conversationId: task.conversationId,
      requestKey: "loop",
      message: "帮助我",
    });
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(
      Array.from({ length: 10 }, (_, i) =>
        fauxAssistantMessage(
          fauxToolCall("get_student_context", {}, { id: `call-${i}` }),
          { stopReason: "toolUse" },
        ),
      ),
    );
    const g = new ModelGateway(
      { models, model: faux.getModel() },
      new ModelBudget(),
    );
    await expect(
      new TutorExecutor(db, f.auth, f.catalog, runs, g).execute(
        runId,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM tool_calls WHERE run_id=$1",
          [runId],
        )
      ).rows[0].n,
    ).toBe(8);
  }));
it("model_receives_sealed_image_bytes_in_user_content", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: revision.id,
      kind: "free_question",
    });
    const first = await uploadAnswerImage(
      f,
      task.conversationId,
      answerPng(40),
    );
    const second = await uploadAnswerImage(
      f,
      task.conversationId,
      answerPng(180),
    );
    const runs = new RunService(db, f.auth, f.store);
    const { runId } = await runs.submit(f.scope, {
      conversationId: task.conversationId,
      requestKey: "sealed-image",
      message: "",
      attachmentIds: [second.fileId, first.fileId],
    });
    const reads = new Map<string, number>();
    const read = f.store.read.bind(f.store);
    f.store.read = async (key) => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return read(key);
    };
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
          fauxToolCall("get_student_context", {}, { id: "context-call" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        seen = context.messages;
        return fauxAssistantMessage("我看到两张作答图片。");
      },
    ]);
    const gateway = new ModelGateway(
      {
        models,
        model: { ...faux.getModel(), contextWindow: 16000, maxTokens: 2048 },
      },
      new ModelBudget(),
    );
    await new TutorExecutor(
      db,
      f.auth,
      f.catalog,
      runs,
      gateway,
      {},
      f.store,
    ).execute(runId, new AbortController().signal);
    const images = imageBlocks(seen);
    expect(images.map((block) => block.data)).toEqual([
      second.bytes.toString("base64"),
      first.bytes.toString("base64"),
    ]);
    expect(images.map((block) => block.mimeType)).toEqual([
      "image/png",
      "image/png",
    ]);
    expect(reads.get(second.key)).toBe(1);
    expect(reads.get(first.key)).toBe(1);
    expect((await runs.get(f.scope, runId)).content).toBe(
      "我看到两张作答图片。",
    );
    const events = await runs.events.readAfter(f.scope, runId);
    expect(JSON.stringify(events)).not.toContain(
      second.bytes.toString("base64"),
    );
    expect(JSON.stringify(events)).not.toContain("download");
  }));
it("fails_before_model_when_current_image_cannot_be_read", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: revision.id,
      kind: "free_question",
    });
    const image = await uploadAnswerImage(
      f,
      task.conversationId,
      answerPng(90),
    );
    const runs = new RunService(db, f.auth, f.store);
    const { runId } = await runs.submit(f.scope, {
      conversationId: task.conversationId,
      requestKey: "broken-image",
      message: "",
      attachmentIds: [image.fileId],
    });
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
    await expect(
      new TutorExecutor(
        db,
        f.auth,
        f.catalog,
        runs,
        gateway,
        {},
        f.store,
      ).execute(runId, new AbortController().signal),
    ).rejects.toThrow("图片");
    expect(faux.state.callCount).toBe(0);
  }));
it("caps_model_images_at_six_across_history", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: revision.id,
      kind: "free_question",
    });
    const history = [
      await appendHistoryImage(f, task.conversationId, answerPng(20), "h1", 40),
      await appendHistoryImage(f, task.conversationId, answerPng(60), "h2", 30),
      await appendHistoryImage(
        f,
        task.conversationId,
        answerPng(100),
        "h3",
        20,
      ),
      await appendHistoryImage(
        f,
        task.conversationId,
        answerPng(140),
        "h4",
        10,
      ),
    ];
    const current = [
      await uploadAnswerImage(f, task.conversationId, answerPng(200)),
      await uploadAnswerImage(f, task.conversationId, answerPng(220)),
      await uploadAnswerImage(f, task.conversationId, answerPng(240)),
    ];
    const runs = new RunService(db, f.auth, f.store);
    const { runId } = await runs.submit(f.scope, {
      conversationId: task.conversationId,
      requestKey: "six-images",
      message: "看我的作答",
      attachmentIds: current.map((image) => image.fileId),
    });
    const faux = fauxProvider({
      models: [{ id: "vision", input: ["text", "image"] }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    let seen: Message[] = [];
    faux.setResponses([
      (context) => {
        seen = context.messages;
        return fauxAssistantMessage("收到。");
      },
    ]);
    const gateway = new ModelGateway(
      { models, model: faux.getModel() },
      new ModelBudget(),
    );
    await new TutorExecutor(
      db,
      f.auth,
      f.catalog,
      runs,
      gateway,
      {},
      f.store,
    ).execute(runId, new AbortController().signal);
    expect(imageBlocks(seen).map((block) => block.data)).toEqual([
      ...history.slice(1).map((image) => image.bytes.toString("base64")),
      ...current.map((image) => image.bytes.toString("base64")),
    ]);
  }));
it("keeps_pure_image_input_when_text_budget_drops_history", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: revision.id,
      kind: "free_question",
    });
    const messages = new MessageService(db, f.auth);
    const old = await messages.append(f.scope, {
      conversationId: task.conversationId,
      role: "user",
      content: "旧消息",
    });
    await db.pool.query(
      "UPDATE messages SET created_at=now() - interval '20 minutes' WHERE id=$1",
      [old.id],
    );
    const huge = await messages.append(f.scope, {
      conversationId: task.conversationId,
      role: "assistant",
      content: "长".repeat(20000),
    });
    await db.pool.query(
      "UPDATE messages SET created_at=now() - interval '10 minutes' WHERE id=$1",
      [huge.id],
    );
    const image = await uploadAnswerImage(
      f,
      task.conversationId,
      answerPng(150),
    );
    const runs = new RunService(db, f.auth, f.store);
    const { runId } = await runs.submit(f.scope, {
      conversationId: task.conversationId,
      requestKey: "pure-image",
      message: "",
      attachmentIds: [image.fileId],
    });
    const run = await runs.get(f.scope, runId);
    const context = await buildContext(
      db,
      f.auth,
      f.catalog,
      f.scope,
      task.conversationId,
      8000,
      {
        reader: new ImageEvidenceReader(db, f.store),
        inputVersionId: run.inputVersionId,
        signal: new AbortController().signal,
      },
    );
    expect(context.inputMatched).toBe(true);
    expect(context.messages).toHaveLength(0);
    expect(context.inputContent?.map((block) => block.type)).toEqual(["image"]);
    expect(context.inputContent?.[0]).toMatchObject({
      type: "image",
      data: image.bytes.toString("base64"),
      mimeType: "image/png",
    });
  }));
it("rejects_image_input_when_model_capability_is_disabled", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: revision.id,
      kind: "free_question",
    });
    const image = await uploadAnswerImage(
      f,
      task.conversationId,
      answerPng(70),
    );
    const runs = new RunService(db, f.auth, f.store);
    const { runId } = await runs.submit(f.scope, {
      conversationId: task.conversationId,
      requestKey: "text-only",
      message: "",
      attachmentIds: [image.fileId],
    });
    const faux = fauxProvider({
      models: [{ id: "text-only", input: ["text"] }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("不应被调用")]);
    const gateway = new ModelGateway(
      { models, model: faux.getModel() },
      new ModelBudget(),
    );
    await expect(
      new TutorExecutor(
        db,
        f.auth,
        f.catalog,
        runs,
        gateway,
        {},
        f.store,
      ).execute(runId, new AbortController().signal),
    ).rejects.toThrow("当前模型不支持图片输入");
    expect(faux.state.callCount).toBe(0);
  }));
