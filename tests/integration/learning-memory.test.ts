import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { SummaryService } from "../../apps/server/src/modules/learning/summaries.js";
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
