import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { AttemptService } from "../../apps/server/src/modules/learning/attempts.js";
import { TimingService } from "../../apps/server/src/modules/tutoring/timing-service.js";
import {
  cleanupSealedTimingEvents,
  enqueueDailyTimingCleanup,
  TIMING_CLEANUP_BATCH_SIZE,
  TIMING_RETENTION_DAYS,
} from "../../apps/server/src/jobs/timing-cleanup-job.js";
import { JobQueue } from "../../apps/server/src/jobs/queue.js";
import type { TimingEventInput } from "../../packages/contracts/src/learning-timing.js";
import type { EpisodeDTO } from "../../packages/contracts/src/tutoring.js";
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
  let seq = 0;
  const segments = new Map<string, string>();
  const event = (
    episode: EpisodeDTO,
    kind: TimingEventInput["kind"],
    cumulativeActiveMs = 0,
  ): TimingEventInput => {
    let segmentId = segments.get(episode.id);
    if (!segmentId) {
      segmentId = randomUUID();
      segments.set(episode.id, segmentId);
    }
    return {
      eventId: randomUUID(),
      episodeId: episode.id,
      leaseEpoch: episode.leaseEpoch,
      seq: ++seq,
      segmentId,
      kind,
      cumulativeActiveMs,
      phase: "initial",
      expectedVersion: 1,
    };
  };
  const start = async (requestKey: string) =>
    timing.start(f.scope, {
      taskId: task.id,
      questionVersionId: question.questionVersionId,
      requestKey,
      takeOver: true,
    });
  return { f, task, question, messages, timing, attempts, event, start };
}

async function countEvents(db: Database, episodeId: string): Promise<number> {
  return (
    await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM timing_events WHERE episode_id=$1",
      [episodeId],
    )
  ).rows[0]!.n;
}

async function backdate(db: Database, episodeId: string, days: number) {
  await db.pool.query(
    "UPDATE timing_events SET created_at = now() - ($2::int * interval '1 day') WHERE episode_id=$1",
    [episodeId, days],
  );
}

it("deletes only sealed, aggregated events past retention", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);

    const unaggregated = await s.start("episode-unaggregated");
    await s.timing.append(s.f.scope, unaggregated.id, [
      s.event(unaggregated, "start"),
      s.event(unaggregated, "finish", 1_000),
    ]);
    await backdate(db, unaggregated.id, 40);

    const recent = await s.start("episode-recent");
    await s.timing.append(s.f.scope, recent.id, [s.event(recent, "start")]);
    const recentMessage = await s.messages.append(s.f.scope, {
      conversationId: s.task.conversationId,
      role: "user",
      content: "1",
    });
    await s.attempts.submit(s.f.scope, {
      requestKey: `answer-${recent.id}`,
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      answer: "1",
      messageVersionId: recentMessage.versionId,
      episodeId: recent.id,
      timingFinalEvent: s.event(recent, "finish", 60_000),
    });

    const stale = await s.start("episode-stale");
    await s.timing.append(s.f.scope, stale.id, [s.event(stale, "start")]);
    const staleMessage = await s.messages.append(s.f.scope, {
      conversationId: s.task.conversationId,
      role: "user",
      content: "1",
    });
    const staleAttempt = await s.attempts.submit(s.f.scope, {
      requestKey: `answer-${stale.id}`,
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      answer: "1",
      messageVersionId: staleMessage.versionId,
      episodeId: stale.id,
      timingFinalEvent: s.event(stale, "finish", 60_000),
    });
    await backdate(db, stale.id, TIMING_RETENTION_DAYS + 1);

    const open = await s.start("episode-open");
    await s.timing.append(s.f.scope, open.id, [s.event(open, "start")]);
    await backdate(db, open.id, 40);

    const snapshotBefore = (
      await db.pool.query(
        "SELECT * FROM attempt_timing_snapshots WHERE attempt_id=$1",
        [staleAttempt.id],
      )
    ).rows[0];
    const segmentsBefore = (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM timing_segments WHERE episode_id=$1",
        [stale.id],
      )
    ).rows[0]!.n;
    await db.pool.query(
      `INSERT INTO learning_evaluations(
        student_id, from_date, to_date, metric_version, metrics, sample_size
      ) VALUES($1, current_date - 30, current_date, 'test', '{}'::jsonb, 1)`,
      [s.f.scope.studentId],
    );

    const result = await cleanupSealedTimingEvents(db);

    expect(result.deleted).toBeGreaterThan(0);
    expect(await countEvents(db, stale.id)).toBe(0);
    expect(await countEvents(db, open.id)).toBeGreaterThan(0);
    expect(await countEvents(db, unaggregated.id)).toBeGreaterThan(0);
    expect(await countEvents(db, recent.id)).toBeGreaterThan(0);

    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM timing_segments WHERE episode_id=$1",
          [stale.id],
        )
      ).rows[0]!.n,
    ).toBe(segmentsBefore);
    expect(
      (
        await db.pool.query(
          "SELECT * FROM attempt_timing_snapshots WHERE attempt_id=$1",
          [staleAttempt.id],
        )
      ).rows[0],
    ).toEqual(snapshotBefore);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM learning_evaluations WHERE student_id=$1",
          [s.f.scope.studentId],
        )
      ).rows[0]!.n,
    ).toBe(1);
    expect(
      (
        await db.pool.query(
          "SELECT state FROM tutoring_episodes WHERE id=$1",
          [stale.id],
        )
      ).rows[0]!.state,
    ).toBe("finished");
  }));

it("cleans in batches and reruns idempotently", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    const episode = await s.start("episode-bulk");
    await s.timing.append(s.f.scope, episode.id, [s.event(episode, "start")]);
    const bulkMessage = await s.messages.append(s.f.scope, {
      conversationId: s.task.conversationId,
      role: "user",
      content: "1",
    });
    await s.attempts.submit(s.f.scope, {
      requestKey: `answer-${episode.id}`,
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      answer: "1",
      messageVersionId: bulkMessage.versionId,
      episodeId: episode.id,
      timingFinalEvent: s.event(episode, "finish", 60_000),
    });
    const extra = TIMING_CLEANUP_BATCH_SIZE * 2 + 1;
    await db.pool.query(
      `INSERT INTO timing_events(
        episode_id,event_id,seq,segment_id,lease_epoch,kind,
        cumulative_active_ms,accepted_ms,phase,payload_hash,received_at,created_at
      )
      SELECT $1, gen_random_uuid(), 1000 + g, $1, 1, 'checkpoint', 0, 0,
             'initial', 'hash-' || g, now() - interval '31 days',
             now() - interval '31 days'
      FROM generate_series(1, $2) g`,
      [episode.id, extra],
    );
    await backdate(db, episode.id, TIMING_RETENTION_DAYS + 1);

    const first = await cleanupSealedTimingEvents(db);
    expect(first.deleted).toBe(extra + 2);
    expect(first.batches).toBeGreaterThan(1);
    expect(await countEvents(db, episode.id)).toBe(0);

    const second = await cleanupSealedTimingEvents(db);
    expect(second).toEqual({ deleted: 0, batches: 1 });
  }));

it("enqueues timing cleanup at most once per UTC day", async () =>
  withTestDb(async (db) => {
    const jobs = new JobQueue(db);
    await enqueueDailyTimingCleanup(jobs, db, new Date("2026-03-05T10:00:00Z"));
    await enqueueDailyTimingCleanup(jobs, db, new Date("2026-03-05T23:59:00Z"));
    expect(
      (
        await db.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM jobs WHERE kind='learning_timing.cleanup'",
        )
      ).rows[0]!.n,
    ).toBe(1);

    await enqueueDailyTimingCleanup(jobs, db, new Date("2026-03-06T00:01:00Z"));
    expect(
      (
        await db.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM jobs WHERE kind='learning_timing.cleanup'",
        )
      ).rows[0]!.n,
    ).toBe(2);
  }));

it("keeps access boundaries and other students' unsealed events", async () =>
  withTestDb(async (db) => {
    const s = await setup(db);
    const otherInvite = await s.f.auth.invite(s.f.admin, { login: "student2" });
    const otherStudent = await s.f.auth.activate({
      token: otherInvite.activationToken,
      password: "long-test-password",
    });
    const otherScope = await s.f.auth.requireStudentAccess(
      { userId: otherStudent.userId, role: "student" },
      otherStudent.studentId!,
    );

    const sealed = await s.start("episode-sealed");
    await s.timing.append(s.f.scope, sealed.id, [s.event(sealed, "start")]);
    const sealedMessage = await s.messages.append(s.f.scope, {
      conversationId: s.task.conversationId,
      role: "user",
      content: "1",
    });
    await s.attempts.submit(s.f.scope, {
      requestKey: `answer-${sealed.id}`,
      taskId: s.task.id,
      questionVersionId: s.question.questionVersionId,
      answer: "1",
      messageVersionId: sealedMessage.versionId,
      episodeId: sealed.id,
      timingFinalEvent: s.event(sealed, "finish", 60_000),
    });
    await backdate(db, sealed.id, TIMING_RETENTION_DAYS + 1);

    await db.pool.query(
      `INSERT INTO timing_events(
        episode_id,event_id,seq,segment_id,lease_epoch,kind,
        cumulative_active_ms,accepted_ms,phase,payload_hash,received_at,created_at
      ) VALUES($1, gen_random_uuid(), 50, $1, 1, 'checkpoint', 0, 0,
             'initial', 'other', now() - interval '31 days',
             now() - interval '31 days')`,
      [sealed.id],
    );

    await cleanupSealedTimingEvents(db);

    await expect(
      s.timing.get(otherScope, sealed.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM timing_events WHERE episode_id=$1",
          [sealed.id],
        )
      ).rows[0]!.n,
    ).toBe(0);
  }));
