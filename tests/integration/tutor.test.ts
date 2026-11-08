import { it, expect } from "vitest";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { RunService } from "../../apps/server/src/modules/conversations/runs.js";
import { ModelGateway } from "../../apps/server/src/agent/provider.js";
import { ModelBudget } from "../../apps/server/src/agent/model-budget.js";
import { BootstrapService } from "../../apps/server/src/agent/bootstrap.js";
import { TutorExecutor } from "../../apps/server/src/agent/tutor.js";
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
    const tool = tools.find((x) => x.name === "search_textbook")!;
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
