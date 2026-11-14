import { it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { AttemptService } from "../../apps/server/src/modules/learning/attempts.js";
import { TimingService } from "../../apps/server/src/modules/tutoring/timing-service.js";
import { episodeSchema } from "../../packages/contracts/src/tutoring.js";
import type { EpisodeDTO } from "../../packages/contracts/src/tutoring.js";
import type { TimingEventInput } from "../../packages/contracts/src/learning-timing.js";
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
    stem: "1/2 + 1/2 = ?",
    referenceAnswer: "1",
    role: "original",
  });
  const messages = new MessageService(db, f.auth);
  const timing = new TimingService(db, f.auth);
  const attempts = new AttemptService(db, f.auth, timing);
  const segmentId = randomUUID();
  let seq = 0;
  const event = (
    episode: EpisodeDTO,
    kind: TimingEventInput["kind"],
    cumulativeActiveMs = 0,
    overrides: Partial<TimingEventInput> = {},
  ): TimingEventInput => ({
    eventId: randomUUID(),
    episodeId: episode.id,
    leaseEpoch: episode.leaseEpoch,
    seq: ++seq,
    segmentId,
    kind,
    cumulativeActiveMs,
    phase: "initial",
    expectedVersion: 1,
    ...overrides,
  });
  const answer = async (content: string) =>
    (
      await messages.append(f.scope, {
        conversationId: task.conversationId,
        role: "user",
        content,
      })
    ).versionId;
  return {
    f,
    tasks,
    task,
    question,
    messages,
    timing,
    attempts,
    segmentId,
    event,
    answer,
  };
}

it("lets only one concurrent start hold the active lease", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    const results = await Promise.allSettled([
      s.timing.start(s.f.scope, {
        taskId: s.task.id,
        questionVersionId: s.question.questionVersionId,
        requestKey: "episode-a",
      }),
      s.timing.start(s.f.scope, {
        taskId: s.task.id,
        questionVersionId: s.question.questionVersionId,
        requestKey: "episode-b",
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
      message: "已有进行中的作答",
    });
    const active = await db.pool.query(
      "SELECT count(*)::int AS n FROM tutoring_episodes WHERE state IN ('active','paused')",
    );
    expect(active.rows[0].n).toBe(1);
  }));

it("rejects the previous lease epoch once a new episode takes over", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    const first = await s.timing.start(s.f.scope, {
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      requestKey: "episode-1",
    });
    await s.timing.append(s.f.scope, first.id, [s.event(first, "start")]);

    const second = await s.timing.start(s.f.scope, {
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      requestKey: "episode-2",
      takeOver: true,
    });
    expect(second.leaseEpoch).toBe(first.leaseEpoch + 1);
    expect(second.id).not.toBe(first.id);

    const stale = s.event(first, "checkpoint", 1000);
    await expect(
      s.timing.append(s.f.scope, first.id, [stale]),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "作答租约已被接管" });
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM timing_events"))
        .rows[0].n,
    ).toBe(1);
  }));

it("retries identical events idempotently and refuses a different payload", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    const episode = await s.timing.start(s.f.scope, {
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      requestKey: "episode-1",
    });
    const start = s.event(episode, "start");
    const once = await s.timing.append(s.f.scope, episode.id, [start]);
    const twice = await s.timing.append(s.f.scope, episode.id, [start]);
    expect(twice.lastSeq).toBe(once.lastSeq);
    expect(twice.version).toBe(once.version);
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM timing_events"))
        .rows[0].n,
    ).toBe(1);

    await expect(
      s.timing.append(s.f.scope, episode.id, [
        { ...start, cumulativeActiveMs: 5_000 },
      ]),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "重复事件内容不同" });
  }));

it("restores the snapshot after an out-of-order batch", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    const episode = await s.timing.start(s.f.scope, {
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      requestKey: "episode-1",
    });
    const start = s.event(episode, "start");
    const second = s.event(episode, "checkpoint", 1_000);
    const third = s.event(episode, "checkpoint", 2_000);
    await s.timing.append(s.f.scope, episode.id, [start]);
    const appended = await s.timing.append(s.f.scope, episode.id, [
      third,
      second,
    ]);
    expect(appended.lastSeq).toBe(third.seq);

    const restored = episodeSchema.parse(
      await s.timing.get(s.f.scope, episode.id),
    );
    expect(restored.lastSeq).toBe(third.seq);
    expect(restored.timing).toEqual(appended.timing);
    expect(restored.state).toBe("active");
  }));

it("stores one timing snapshot per attempt and degrades without an episode", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    const episode = await s.timing.start(s.f.scope, {
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      requestKey: "episode-1",
    });
    const start = s.event(episode, "start");
    await s.timing.append(s.f.scope, episode.id, [start]);
    const finish = s.event(episode, "finish", 60_000);
    const messageVersionId = await s.answer("1");

    const input = {
      requestKey: "answer-1",
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      answer: "1",
      messageVersionId,
      episodeId: episode.id,
      timingFinalEvent: finish,
    };
    const first = await s.attempts.submit(s.f.scope, input);
    const retried = await s.attempts.submit(s.f.scope, input);
    expect(retried.id).toBe(first.id);
    expect(retried.timing).toEqual(first.timing);
    expect(first.answer).toBe("1");
    expect(first.messageVersionId).toBe(messageVersionId);
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM attempts")).rows[0]
        .n,
    ).toBe(1);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM attempt_timing_snapshots",
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM timing_events WHERE kind='finish'",
        )
      ).rows[0].n,
    ).toBe(1);

    const untimed = await s.attempts.submit(s.f.scope, {
      requestKey: "answer-2",
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      answer: "1",
      messageVersionId: await s.answer("1"),
    });
    expect(untimed.timing).toEqual({
      firstAttemptMs: null,
      selfCheckMs: null,
      postHintMs: null,
      totalActiveMs: null,
      wallMs: null,
      quality: "missing",
      reasonCodes: ["not_collected"],
    });
  }));

it("never blocks a saved answer on a stale final timing event", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    const episode = await s.timing.start(s.f.scope, {
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      requestKey: "episode-1",
    });
    await s.timing.append(s.f.scope, episode.id, [s.event(episode, "start")]);
    const stale = { ...s.event(episode, "checkpoint", 1_000), seq: 1 };
    const saved = await s.attempts.submit(s.f.scope, {
      requestKey: "answer-1",
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      answer: "1",
      messageVersionId: await s.answer("1"),
      episodeId: episode.id,
      timingFinalEvent: stale,
    });
    expect(saved.id).toBeTruthy();
    expect(saved.timingWarning).toBe("最终计时事件已过期，本次计时质量降级");
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM attempts")).rows[0]
        .n,
    ).toBe(1);
  }));

it("rolls the whole answer back when the episode belongs to another question", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    const other = await s.tasks.addQuestion(s.f.scope, s.task.id, {
      stem: "1/4 + 1/4 = ?",
      referenceAnswer: "1/2",
      role: "original",
    });
    const episode = await s.timing.start(s.f.scope, {
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      requestKey: "episode-1",
    });
    await expect(
      s.attempts.submit(s.f.scope, {
        requestKey: "answer-1",
        taskId: s.task.id,
        questionVersionId: other.questionVersionId,
        answer: "1/2",
        messageVersionId: await s.answer("1/2"),
        episodeId: episode.id,
        processMessageVersionId: await s.answer("先去分母"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: "作答与计时会话不匹配",
    });
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM attempts")).rows[0]
        .n,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM attempt_process_evidence",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await db.pool.query("SELECT state FROM tutoring_episodes")).rows,
    ).toEqual([{ state: "active" }]);
  }));

it("refuses an expired lease and hides episodes from other students", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    const episode = await s.timing.start(s.f.scope, {
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      requestKey: "episode-1",
    });

    const invitation = await s.f.auth.invite(s.f.admin, { login: "student-2" });
    const other = await s.f.auth.activate({
      token: invitation.activationToken,
      password: "long-test-password",
    });
    const otherScope = await s.f.auth.requireStudentAccess(
      { userId: other.userId, role: "student" },
      other.studentId!,
    );
    await expect(s.timing.get(otherScope, episode.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      s.timing.append(otherScope, episode.id, [s.event(episode, "start")]),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await db.pool.query(
      "UPDATE tutoring_episodes SET lease_expires_at=now()-interval '1 minute' WHERE id=$1",
      [episode.id],
    );
    await expect(
      s.timing.append(s.f.scope, episode.id, [s.event(episode, "start")]),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "作答租约已过期" });
  }));

it("keeps teaching available after the first answer submission", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    const e = await s.timing.start(s.f.scope, {
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      requestKey: "continue-teaching",
    });
    await s.timing.append(s.f.scope, e.id, [s.event(e, "start")]);
    const saved = await s.attempts.submit(s.f.scope, {
      requestKey: "answer",
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      answer: "2",
      messageVersionId: await s.answer("2"),
      episodeId: e.id,
      timingFinalEvent: s.event(e, "finish"),
    });
    expect(saved.id).toBeTruthy();
    const { TutoringService } =
      await import("../../apps/server/src/modules/tutoring/service.js");
    const tutoring = new TutoringService(db, s.f.auth, s.timing);
    const current = await tutoring.current(s.f.scope, s.task.id);
    expect(current?.id).toBe(e.id);
    const action = await tutoring.act(s.f.scope, e.id, {
      requestKey: "hint",
      expectedVersion: current!.version,
      kind: "request_hint",
    });
    expect(action.content).not.toBe("");
  }));

it.each([false, true])(
  "marks missing/stale final timing as partial (%s)",
  async (stale) =>
    withTestDb(async (db) => {
      const s = await setup(db);
      const e = await s.timing.start(s.f.scope, {
        taskId: s.task.id,
        questionVersionId: s.question.questionVersionId,
        requestKey: "incomplete",
      });
      const first = s.event(e, "start");
      await s.timing.append(s.f.scope, e.id, [first]);
      if (stale) {
        await s.timing.append(s.f.scope, e.id, [s.event(e, "pause")]);
      }
      const saved = await s.attempts.submit(s.f.scope, {
        requestKey: "incomplete-answer",
        taskId: s.task.id,
        questionVersionId: s.question.questionVersionId,
        answer: "1",
        messageVersionId: await s.answer("1"),
        episodeId: e.id,
        ...(stale
          ? { timingFinalEvent: { ...first, eventId: randomUUID() } }
          : {}),
      });
      expect(saved.timing?.quality).toBe("partial");
      expect(saved.timingWarning).toBeTruthy();
      expect((await s.timing.get(s.f.scope, e.id)).timing.quality).toBe("partial");
    }),
);

it("recovers clipped cumulative time across database round trips", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const base = Date.now();
      const e = await s.timing.start(s.f.scope, {
        taskId: s.task.id,
        questionVersionId: s.question.questionVersionId,
        requestKey: "clipping",
      });
      await s.timing.append(s.f.scope, e.id, [s.event(e, "start")]);
      vi.setSystemTime(base + 15_000);
      await s.timing.append(s.f.scope, e.id, [
        s.event(e, "checkpoint", 20_000),
      ]);
      vi.setSystemTime(base + 30_000);
      const end = await s.timing.append(s.f.scope, e.id, [
        s.event(e, "pause", 30_000),
      ]);
      expect(end.timing.totalActiveMs).toBe(30_000);
      expect(end.timing.quality).toBe("reliable");
    } finally {
      vi.useRealTimers();
    }
  }));

it("saves a late answer without reopening an episode taken over by another tab", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    const first = await s.timing.start(s.f.scope, {
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      requestKey: "old-tab",
    });
    await s.timing.append(s.f.scope, first.id, [s.event(first, "start")]);
    const next = await s.timing.start(s.f.scope, {
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      requestKey: "new-tab",
      takeOver: true,
    });
    const saved = await s.attempts.submit(s.f.scope, {
      requestKey: "late-answer",
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      answer: "1",
      messageVersionId: await s.answer("1"),
      episodeId: first.id,
      timingFinalEvent: s.event(first, "finish"),
    });
    expect(saved.timing?.quality).toBe("partial");
    expect((await s.timing.get(s.f.scope, first.id)).state).toBe("finished");
    expect((await s.timing.get(s.f.scope, next.id)).state).toBe("active");
  }));
