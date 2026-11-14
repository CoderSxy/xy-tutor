import { expect, it } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";

it("continues a completed task in the same conversation and completes it again", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, { kind: "free_question" });
    const question = await tasks.addQuestion(f.scope, task.id, {
      stem: "1+1=?",
      role: "original",
    });
    const messages = new MessageService(db, f.auth);
    await messages.append(f.scope, {
      conversationId: task.conversationId,
      role: "user",
      content: "请解释这道题",
    });
    const completed = await tasks.transition(f.scope, {
      taskId: task.id,
      expectedVersion: task.version,
      status: "completed",
    });
    // A completed task can only be reopened, and stale updates still conflict.
    for (const status of ["paused", "abandoned", "completed"]) {
      await expect(
        tasks.transition(f.scope, {
          taskId: task.id,
          expectedVersion: completed.version,
          status,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }
    await expect(
      tasks.transition(f.scope, {
        taskId: task.id,
        expectedVersion: task.version,
        status: "active",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const continued = await tasks.transition(f.scope, {
      taskId: task.id,
      expectedVersion: completed.version,
      status: "active",
    });
    expect(continued).toMatchObject({
      id: task.id,
      conversationId: task.conversationId,
      status: "active",
      version: completed.version + 1,
    });
    expect(
      (await tasks.items(f.scope, task.id)).map((q) => q.questionVersionId),
    ).toContain(question.questionVersionId);
    expect(await messages.history(f.scope, task.conversationId)).toHaveLength(
      1,
    );
    await messages.append(f.scope, {
      conversationId: task.conversationId,
      role: "user",
      content: "我还想继续问",
    });
    const ended = await tasks.transition(f.scope, {
      taskId: task.id,
      expectedVersion: continued.version,
      status: "completed",
    });
    expect(ended.status).toBe("completed");
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM jobs WHERE kind='learning.summary'",
        )
      ).rows[0].n,
    ).toBe(2);
  }));

it("does not reopen abandoned or deleted tasks", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, { kind: "free_question" });
    const abandoned = await tasks.transition(f.scope, {
      taskId: task.id,
      expectedVersion: task.version,
      status: "abandoned",
    });
    await expect(
      tasks.transition(f.scope, {
        taskId: task.id,
        expectedVersion: abandoned.version,
        status: "active",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await tasks.remove(f.scope, task.id);
    await expect(
      tasks.transition(f.scope, {
        taskId: task.id,
        expectedVersion: abandoned.version + 1,
        status: "active",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }));
