import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { AttemptService } from "../../apps/server/src/modules/learning/attempts.js";
it("resumes tasks bound to old revisions after textbook replacement", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数通分");
    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, {
      revisionId: revision.id,
      kind: "daily_practice",
    });
    await f.catalog.disable(f.admin, revision.id);
    expect((await tasks.resume(f.scope, task.id)).revisionId).toBe(revision.id);
    await expect(
      tasks.create(f.scope, {
        revisionId: revision.id,
        kind: "daily_practice",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  }));
it("retains edited messages and regenerated answers and rejects stale edits", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: revision.id,
      kind: "free_question",
    });
    const s = new MessageService(db, f.auth);
    const message = await s.append(f.scope, {
      conversationId: task.conversationId,
      role: "user",
      content: "原答案",
      requestKey: "msg-1",
    });
    const edit = await s.edit(f.scope, {
      messageId: message.id,
      expectedVersion: 1,
      content: "更正答案",
    });
    expect(edit.versionNo).toBe(2);
    await expect(
      s.edit(f.scope, {
        messageId: message.id,
        expectedVersion: 1,
        content: "另一个设备",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const history = await s.history(f.scope, task.conversationId);
    expect(history[0]?.versions.map((v) => v.content)).toEqual([
      "原答案",
      "更正答案",
    ]);
    const answer = await s.append(f.scope, {
      conversationId: task.conversationId,
      role: "assistant",
      content: "首次回答",
    });
    const regenerated = await s.regenerate(f.scope, {
      messageId: answer.id,
      content: "重新生成",
    });
    expect(regenerated.id).not.toBe(answer.id);
  }));
it("stores immutable attempts once and refuses foreign question ownership", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数");
    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, {
      revisionId: revision.id,
      kind: "daily_practice",
    });
    const question = await tasks.addQuestion(f.scope, task.id, {
      stem: "1/2 + 1/2 = ?",
      referenceAnswer: "1",
      role: "original",
    });
    const message = await new MessageService(db, f.auth).append(f.scope, {
      conversationId: task.conversationId,
      role: "user",
      content: "2",
    });
    const s = new AttemptService(db, f.auth);
    const input = {
      requestKey: "answer-1",
      taskId: task.id,
      questionVersionId: question.questionVersionId,
      answer: "2",
      messageVersionId: message.versionId,
    };
    const first = await s.submit(f.scope, input);
    expect((await s.submit(f.scope, input)).id).toBe(first.id);
    expect((await db.pool.query("SELECT answer FROM attempts")).rows).toEqual([
      { answer: "2" },
    ]);
    await expect(
      s.submit(f.scope, {
        ...input,
        requestKey: "other",
        questionVersionId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }));
it("allows only one versioned task transition per revision number", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "分数");
    const s = new TaskService(db, f.auth, f.catalog);
    const task = await s.create(f.scope, {
      revisionId: revision.id,
      kind: "free_question",
    });
    await s.transition(f.scope, {
      taskId: task.id,
      expectedVersion: task.version,
      status: "paused",
    });
    await expect(
      s.transition(f.scope, {
        taskId: task.id,
        expectedVersion: task.version,
        status: "completed",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  }));
it("pauses an incomplete daily practice rather than completing it", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "加法");
    const s = new TaskService(db, f.auth, f.catalog);
    const t = await s.create(f.scope, {
      revisionId: r.id,
      kind: "daily_practice",
    });
    await expect(
      s.transition(f.scope, {
        taskId: t.id,
        expectedVersion: t.version,
        status: "completed",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (
        await s.transition(f.scope, {
          taskId: t.id,
          expectedVersion: t.version,
          status: "paused",
        })
      ).status,
    ).toBe("paused");
  }));
it("keeps daily practice at five items under concurrent proposals", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "并发练习");
    const s = new TaskService(db, f.auth, f.catalog);
    const task = await s.create(f.scope, {
      revisionId: r.id,
      kind: "daily_practice",
    });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, n) =>
        s.addQuestion(f.scope, task.id, { stem: `${n}+1=?`, role: "original" }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(await s.items(f.scope, task.id)).toHaveLength(5);
  }));
