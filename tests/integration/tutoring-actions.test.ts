import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { AttemptService } from "../../apps/server/src/modules/learning/attempts.js";
import { AssessmentService } from "../../apps/server/src/modules/learning/assessments.js";
import { TimingService } from "../../apps/server/src/modules/tutoring/timing-service.js";
import { TutoringService } from "../../apps/server/src/modules/tutoring/service.js";
import type { Database } from "../../packages/db/src/client.js";

async function setup(db: Database) {
  const f = await catalogFixture(db);
  const revision = await f.publish("人教版", "分数通分");
  const tasks = new TaskService(db, f.auth, f.catalog);
  const task = await tasks.create(f.scope, {
    revisionId: revision.id,
    kind: "free_question",
  });
  const question = await tasks.addQuestion(f.scope, task.id, {
    stem: "1/2 + 1/3 = ?",
    referenceAnswer: "5/6",
    role: "original",
  });
  const messages = new MessageService(db, f.auth);
  const timing = new TimingService(db, f.auth);
  const attempts = new AttemptService(db, f.auth, timing);
  const tutoring = new TutoringService(db, f.auth, timing);
  const assessments = new AssessmentService(db, f.auth, f.catalog);
  const episode = await timing.start(f.scope, {
    taskId: task.id,
    questionVersionId: question.questionVersionId,
    requestKey: "episode-1",
  });
  const answer = async (input: {
    content: string;
    requestKey: string;
    questionVersionId?: string;
    taskId?: string;
    conversationId?: string;
  }) => {
    const message = await messages.append(f.scope, {
      conversationId: input.conversationId ?? task.conversationId,
      role: "user",
      content: input.content,
    });
    return attempts.submit(f.scope, {
      taskId: input.taskId ?? task.id,
      questionVersionId: input.questionVersionId ?? question.questionVersionId,
      messageVersionId: message.versionId,
      answer: input.content,
      requestKey: input.requestKey,
    });
  };
  const assess = (attemptId: string) =>
    assessments.submitCandidate(f.scope, {
      attemptId,
      correctness: "correct",
      reason: "学生自评",
      referenceIds: [],
    });
  return {
    f,
    revision,
    tasks,
    task,
    question,
    messages,
    timing,
    attempts,
    tutoring,
    assessments,
    episode,
    answer,
    assess,
  };
}

it("keeps a sent solution exposed even when the display receipt is lost", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    const action = await s.tutoring.act(s.f.scope, s.episode.id, {
      requestKey: "explain-1",
      expectedVersion: s.episode.version,
      kind: "request_explanation",
    });
    expect(action.exposure).toBe("solution_exposed");
    expect(action.displayStatus).toBe("sent");
    expect(action.content).not.toBe("");

    // 回执丢失：学生端始终没有 acknowledge。
    const level = (
      await db.pool.query<{ level: string }>(
        "SELECT h.level FROM hints h JOIN tutoring_actions a ON a.hint_id=h.id WHERE a.id=$1",
        [action.id],
      )
    ).rows[0];
    expect(level?.level).toBe("solution_exposed");

    const attempt = await s.answer({ content: "5/6", requestKey: "a-1" });
    const assessment = await s.assess(attempt.id);
    expect(assessment.hintDependency).toBe("solution_exposed");

    const stored = (
      await db.pool.query<{ hint_dependency: string }>(
        "SELECT hint_dependency FROM assessments WHERE id=$1",
        [assessment.id],
      )
    ).rows[0];
    expect(stored?.hint_dependency).toBe("solution_exposed");
  }));

it("exposes free text solutions that bypass the action ledger", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    await s.messages.append(s.f.scope, {
      conversationId: s.task.conversationId,
      role: "assistant",
      content: "这道题的解法如下：先通分再相加。最终答案是：5/6。",
    });
    const attempt = await s.answer({ content: "5/6", requestKey: "a-1" });
    const assessment = await s.assess(attempt.id);
    expect(assessment.hintDependency).toBe("solution_exposed");
  }));

it("does not leak hints across tasks or students", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    const otherTask = await s.tasks.create(s.f.scope, {
      revisionId: s.revision.id,
      kind: "free_question",
    });
    const otherMessage = await s.messages.append(s.f.scope, {
      conversationId: otherTask.conversationId,
      role: "assistant",
      content: "解法如下：把分子相加。",
    });
    // 恶意或错误的记录：把别的任务里的消息挂到当前任务与题目上。
    await db.pool.query(
      "INSERT INTO hints(task_id,question_version_id,message_version_id,level) VALUES($1,$2,$3,'solution_exposed')",
      [s.task.id, s.question.questionVersionId, otherMessage.versionId],
    );

    const invitation = await s.f.auth.invite(s.f.admin, { login: "student2" });
    const second = await s.f.auth.activate({
      token: invitation.activationToken,
      password: "long-test-password",
    });
    const foreignConversation = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO conversations(student_id,task_id) VALUES($1,$2) RETURNING id",
        [second.studentId, s.task.id],
      )
    ).rows[0]!;
    const foreignMessage = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO messages(conversation_id,role) VALUES($1,'assistant') RETURNING id",
        [foreignConversation.id],
      )
    ).rows[0]!;
    const foreignVersion = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO message_versions(message_id,version_no,content) VALUES($1,1,$2) RETURNING id",
        [foreignMessage.id, "解法如下：通分后相加。"],
      )
    ).rows[0]!;
    await db.pool.query(
      "INSERT INTO hints(task_id,question_version_id,message_version_id,level) VALUES($1,$2,$3,'solution_exposed')",
      [s.task.id, s.question.questionVersionId, foreignVersion.id],
    );

    const attempt = await s.answer({ content: "5/6", requestKey: "a-1" });
    const assessment = await s.assess(attempt.id);
    expect(assessment.hintDependency).toBe("none");
  }));

it("replays the same request without recording another failed check", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    const input = {
      requestKey: "hint-1",
      expectedVersion: s.episode.version,
      kind: "request_hint" as const,
    };
    const first = await s.tutoring.act(s.f.scope, s.episode.id, input);
    const replay = await s.tutoring.act(s.f.scope, s.episode.id, input);
    expect(replay.id).toBe(first.id);

    const states = (
      await db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM tutoring_states WHERE episode_id=$1",
        [s.episode.id],
      )
    ).rows[0]!;
    expect(states.n).toBe(1);
    const failed = (
      await db.pool.query<{ failed_checks: number }>(
        "SELECT failed_checks FROM tutoring_states WHERE episode_id=$1 ORDER BY version DESC LIMIT 1",
        [s.episode.id],
      )
    ).rows[0]!;
    expect(failed.failed_checks).toBe(0);
    const actions = (
      await db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM tutoring_actions WHERE episode_id=$1",
        [s.episode.id],
      )
    ).rows[0]!;
    expect(actions.n).toBe(1);

    await expect(
      s.tutoring.act(s.f.scope, s.episode.id, {
        ...input,
        kind: "request_explanation",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  }));

it("only counts a newly submitted student step as a failed check", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    await s.answer({ content: "1/5", requestKey: "a-1" });
    const action = await s.tutoring.act(s.f.scope, s.episode.id, {
      requestKey: "hint-1",
      expectedVersion: s.episode.version,
      kind: "request_hint",
    });
    expect(action.exposure).toBe("guided");
    const failed = (
      await db.pool.query<{ failed_checks: number }>(
        "SELECT failed_checks FROM tutoring_states WHERE episode_id=$1 ORDER BY version DESC LIMIT 1",
        [s.episode.id],
      )
    ).rows[0]!;
    expect(failed.failed_checks).toBe(1);
    expect(action.state).toBe("self_check");

    // 没有新步骤时重复求助，只升一层，不再增加失败次数。
    const fresh = await s.timing.get(s.f.scope, s.episode.id);
    const next = await s.tutoring.act(s.f.scope, s.episode.id, {
      requestKey: "hint-2",
      expectedVersion: fresh.version,
      kind: "request_hint",
    });
    const failedAgain = (
      await db.pool.query<{ failed_checks: number }>(
        "SELECT failed_checks FROM tutoring_states WHERE episode_id=$1 ORDER BY version DESC LIMIT 1",
        [s.episode.id],
      )
    ).rows[0]!;
    expect(failedAgain.failed_checks).toBe(1);
    expect(next.state).toBe("focused_check");
  }));

it("rejects a stale expected version instead of silently advancing", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    const action = await s.tutoring.act(s.f.scope, s.episode.id, {
      requestKey: randomUUID(),
      expectedVersion: s.episode.version,
      kind: "request_hint",
    });
    await expect(
      s.tutoring.act(s.f.scope, s.episode.id, {
        requestKey: randomUUID(),
        expectedVersion: s.episode.version,
        kind: "request_hint",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "状态已更新，请刷新后重试",
    });
    expect(action.stateVersion).toBe(1);
  }));
