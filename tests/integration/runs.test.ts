import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { RunService } from "../../apps/server/src/modules/conversations/runs.js";
import { EventStore } from "../../apps/server/src/modules/conversations/events.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";

const password = "long-test-password";
it("deduplicates submissions and permits only one live run per conversation", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "分数");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: r.id,
      kind: "free_question",
    });
    const s = new RunService(db, f.auth);
    const input = {
      conversationId: task.conversationId,
      requestKey: "one",
      message: "通分是什么",
    };
    const first = await s.submit(f.scope, input);
    expect((await s.submit(f.scope, input)).runId).toBe(first.runId);
    expect((await s.latest(f.scope, task.conversationId))?.id).toBe(
      first.runId,
    );
    await expect(
      s.submit(f.scope, { ...input, requestKey: "two" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM messages WHERE role='user'",
        )
      ).rows[0].n,
    ).toBe(1);
  }));
it("replays persisted events after a cursor and cancels partial replies", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "分数");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: r.id,
      kind: "free_question",
    });
    const runs = new RunService(db, f.auth);
    const { runId } = await runs.submit(f.scope, {
      conversationId: task.conversationId,
      requestKey: "one",
      message: "帮助我",
    });
    const e = new EventStore(db, f.auth);
    const first = await e.append(runId, {
      type: "text_delta",
      data: { text: "先看看" },
    });
    await e.append(runId, { type: "text_delta", data: { text: "分母" } });
    const later = await e.readAfter(f.scope, runId, first.id);
    expect(later).toHaveLength(1);
    expect(later[0]?.data).toEqual({ text: "分母" });
    await runs.cancel(f.scope, runId);
    expect((await runs.get(f.scope, runId)).status).toBe("cancelled");
  }));
it("interrupts expired runs on restart instead of replaying tools", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "分数");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: r.id,
      kind: "free_question",
    });
    const s = new RunService(db, f.auth);
    const { runId } = await s.submit(f.scope, {
      conversationId: task.conversationId,
      requestKey: "one",
      message: "开始",
    });
    await db.pool.query(
      "UPDATE agent_runs SET status='running',lease_expires_at=now()-interval '1 minute' WHERE id=$1",
      [runId],
    );
    await s.recoverExpired(new Date());
    expect((await s.get(f.scope, runId)).status).toBe("interrupted");
  }));
it("records an explicitly submitted answer atomically with the user message and run", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "分数");
    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, {
      revisionId: r.id,
      kind: "daily_practice",
    });
    const q = await tasks.addQuestion(f.scope, task.id, {
      stem: "只填数值：1+1=?",
      role: "original",
    });
    const runs = new RunService(db, f.auth);
    const { runId } = await runs.submit(f.scope, {
      conversationId: task.conversationId,
      requestKey: "answer-run",
      message: "2",
      questionVersionId: q.questionVersionId,
    });
    expect(
      (
        await db.pool.query(
          "SELECT a.answer,a.message_version_id=r.input_version_id AS linked FROM attempts a JOIN agent_runs r ON r.input_version_id=a.message_version_id WHERE r.id=$1",
          [runId],
        )
      ).rows,
    ).toEqual([{ answer: "2", linked: true }]);
  }));
it("retry_reuses_input_without_duplicate_message_or_attempt", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "分数");
    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, {
      revisionId: r.id,
      kind: "daily_practice",
    });
    const q = await tasks.addQuestion(f.scope, task.id, {
      stem: "看图说答案",
      role: "original",
    });
    const runs = new RunService(db, f.auth);
    const original = await runs.submit(f.scope, {
      conversationId: task.conversationId,
      requestKey: "answer-run",
      message: "2",
      questionVersionId: q.questionVersionId,
    });
    await db.pool.query("UPDATE agent_runs SET status='failed' WHERE id=$1", [
      original.runId,
    ]);
    const retried = await runs.retry(f.scope, original.runId, {
      requestKey: "retry-1",
    });
    expect(retried.runId).not.toBe(original.runId);
    expect(
      (
        await runs.retry(f.scope, original.runId, {
          requestKey: "retry-1",
        })
      ).runId,
    ).toBe(retried.runId);
    const source = (
      await db.pool.query(
        "SELECT input_version_id,input_text,mode,question_version_id,actor_id FROM agent_runs WHERE id=$1",
        [original.runId],
      )
    ).rows[0];
    const copy = (
      await db.pool.query(
        "SELECT input_version_id,input_text,mode,question_version_id,actor_id,retry_of_run_id,status FROM agent_runs WHERE id=$1",
        [retried.runId],
      )
    ).rows[0];
    expect(copy).toEqual({ ...source, retry_of_run_id: original.runId, status: "queued" });
    expect(
      (
        await db.pool.query(
          "SELECT (SELECT count(*)::int FROM messages WHERE role='user') AS messages,(SELECT count(*)::int FROM attempts) AS attempts",
        )
      ).rows[0],
    ).toEqual({ messages: 1, attempts: 1 });
  }));
it("retry_rejects_live_or_succeeded_runs_and_stale_inputs", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "分数");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: r.id,
      kind: "free_question",
    });
    const runs = new RunService(db, f.auth);
    const { runId } = await runs.submit(f.scope, {
      conversationId: task.conversationId,
      requestKey: "one",
      message: "第一问",
    });
    await expect(
      runs.retry(f.scope, runId, { requestKey: "retry-1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await db.pool.query("UPDATE agent_runs SET status='running' WHERE id=$1", [
      runId,
    ]);
    await expect(
      runs.retry(f.scope, runId, { requestKey: "retry-1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await db.pool.query("UPDATE agent_runs SET status='succeeded' WHERE id=$1", [
      runId,
    ]);
    await expect(
      runs.retry(f.scope, runId, { requestKey: "retry-1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await db.pool.query("UPDATE agent_runs SET status='cancelled' WHERE id=$1", [
      runId,
    ]);
    const message = (
      await db.pool.query(
        "SELECT id FROM messages WHERE conversation_id=$1 AND role='user'",
        [task.conversationId],
      )
    ).rows[0];
    await new MessageService(db, f.auth).edit(f.scope, {
      messageId: message.id,
      expectedVersion: 1,
      content: "改过的内容",
    });
    await expect(
      runs.retry(f.scope, runId, { requestKey: "retry-1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const invitation = await f.auth.invite(f.admin, { login: "other-retry" });
    const other = await f.auth.activate({
      token: invitation.activationToken,
      password,
    });
    const otherScope = await f.auth.requireStudentAccess(
      { userId: other.userId, role: "student" },
      other.studentId!,
    );
    await expect(
      runs.retry(otherScope, runId, { requestKey: "retry-1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }));
it("retry_allows_a_cancelled_run_after_explicit_action", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "分数");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: r.id,
      kind: "free_question",
    });
    const runs = new RunService(db, f.auth);
    const { runId } = await runs.submit(f.scope, {
      conversationId: task.conversationId,
      requestKey: "one",
      message: "开始讲",
    });
    await runs.cancel(f.scope, runId);
    await expect(
      runs.retry(f.scope, runId, { requestKey: "retry-1" }),
    ).resolves.toMatchObject({ runId: expect.any(String) });
  }));
