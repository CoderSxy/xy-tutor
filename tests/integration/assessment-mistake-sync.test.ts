import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import type { Database } from "../../packages/db/src/client.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { AttemptService } from "../../apps/server/src/modules/learning/attempts.js";
import { AssessmentService } from "../../apps/server/src/modules/learning/assessments.js";
import { MistakeService } from "../../apps/server/src/modules/learning/mistakes.js";
import { JobQueue, type Job } from "../../apps/server/src/jobs/queue.js";
import { assessmentHandler } from "../../apps/server/src/jobs/assessment-job.js";
import { mistakeSyncHandler } from "../../apps/server/src/jobs/mistake-sync-job.js";

type Fixture = Awaited<ReturnType<typeof catalogFixture>>;

async function seed(db: Database, f: Fixture, answer: string) {
  const revision = await f.publish("人教版", "加法");
  const tasks = new TaskService(db, f.auth, f.catalog);
  const task = await tasks.create(f.scope, {
    revisionId: revision.id,
    kind: "daily_practice",
  });
  const question = await tasks.addQuestion(f.scope, task.id, {
    stem: "只填数值：1+1=?",
    referenceAnswer: "2",
    role: "original",
  });
  await db.pool.query(
    "INSERT INTO question_references(question_version_id,answer,answer_type,requires_working,verification,evidence) VALUES($1,'2','number',false,'verified','{}')",
    [question.questionVersionId],
  );
  const message = await new MessageService(db, f.auth).append(f.scope, {
    conversationId: task.conversationId,
    role: "user",
    content: answer,
  });
  const attempt = await new AttemptService(db, f.auth).submit(f.scope, {
    taskId: task.id,
    questionVersionId: question.questionVersionId,
    messageVersionId: message.versionId,
    answer,
    requestKey: `attempt-${answer}`,
  });
  return { task, question, message, attempt };
}

function jobFromRow(row: Record<string, unknown>): Job {
  return {
    id: row.id as string,
    kind: row.kind as string,
    payload: row.payload as Record<string, unknown>,
    leaseToken: "test-lease",
    attempts: Number(row.attempts ?? 1),
  };
}

async function jobFor(db: Database, kind: string): Promise<Job> {
  const row = (
    await db.pool.query(
      "SELECT id,kind,payload,attempts FROM jobs WHERE kind=$1 ORDER BY created_at LIMIT 1",
      [kind],
    )
  ).rows[0];
  if (!row) throw Error(`missing job ${kind}`);
  return jobFromRow(row);
}

it("does not turn chat language into an assessment or mistake", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "加法");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: revision.id,
      kind: "daily_practice",
    });
    await new MessageService(db, f.auth).append(f.scope, {
      conversationId: task.conversationId,
      role: "assistant",
      content: "这道题你做错了。",
    });
    expect(
      (
        await db.pool.query(
          "SELECT (SELECT count(*)::int FROM assessments) AS assessments,(SELECT count(*)::int FROM student_mistakes) AS mistakes,(SELECT count(*)::int FROM jobs WHERE kind='learning.assess') AS queued",
        )
      ).rows[0],
    ).toEqual({ assessments: 0, mistakes: 0, queued: 0 });
  }));

it("automatically assesses a formal attempt and synchronizes one mistake idempotently", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const { attempt } = await seed(db, f, "3");
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM jobs WHERE kind='learning.assess'",
        )
      ).rows[0].n,
    ).toBe(1);

    const assessments = new AssessmentService(db, f.auth, f.catalog);
    const mistakes = new MistakeService(db, f.auth);
    const assess = assessmentHandler(assessments);
    const sync = mistakeSyncHandler(mistakes);

    const assessJob = await jobFor(db, "learning.assess");
    const result = await assess(assessJob, new AbortController().signal);
    expect(result).toMatchObject({
      assessmentId: expect.any(String),
      correctness: "incorrect",
      verification: "verified",
    });
    expect(
      (
        await db.pool.query(
          "SELECT (SELECT count(*)::int FROM assessments WHERE attempt_id=$1) AS assessments,(SELECT count(*)::int FROM jobs WHERE kind='learning.mistake-sync') AS sync_jobs",
          [attempt.id],
        )
      ).rows[0],
    ).toEqual({ assessments: 1, sync_jobs: 1 });

    // A retried assessment job must not duplicate the final assessment or sync job.
    await assess(assessJob, new AbortController().signal);
    expect(
      (
        await db.pool.query(
          "SELECT (SELECT count(*)::int FROM assessments WHERE attempt_id=$1) AS assessments,(SELECT count(*)::int FROM jobs WHERE kind='learning.mistake-sync') AS sync_jobs",
          [attempt.id],
        )
      ).rows[0],
    ).toEqual({ assessments: 1, sync_jobs: 1 });

    const syncJob = await jobFor(db, "learning.mistake-sync");
    await sync(syncJob, new AbortController().signal);
    await sync(syncJob, new AbortController().signal);
    expect(
      (
        await db.pool.query(
          "SELECT (SELECT count(*)::int FROM student_mistakes) AS mistakes,(SELECT count(*)::int FROM mistake_state_events WHERE assessment_id=$1) AS events",
          [syncJob.payload.assessmentId],
        )
      ).rows[0],
    ).toEqual({ mistakes: 1, events: 1 });
  }));

it("ignores a stale incorrect sync after a later correct assessment", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const { attempt } = await seed(db, f, "3");
    const assessments = new AssessmentService(db, f.auth, f.catalog);
    const mistakes = new MistakeService(db, f.auth);
    const assess = assessmentHandler(assessments);
    const sync = mistakeSyncHandler(mistakes);

    await assess(await jobFor(db, "learning.assess"), new AbortController().signal);
    const syncJob = await jobFor(db, "learning.mistake-sync");
    await sync(syncJob, new AbortController().signal);
    const mistake = (
      await db.pool.query("SELECT id,lifecycle FROM student_mistakes")
    ).rows[0];
    expect(mistake.lifecycle).toBe("active");

    const corrected = (
      await db.pool.query(
        `INSERT INTO assessments(attempt_id,correctness,verification,hint_dependency,method,verifier_version,evidence,created_at)
         VALUES($1,'correct','verified','none','independent','assessment-v1','{}',now()+interval '1 second') RETURNING id`,
        [attempt.id],
      )
    ).rows[0];
    await db.pool.query(
      "INSERT INTO jobs(kind,dedupe_key,payload,available_at) VALUES('learning.mistake-sync',$1,$2,now()-interval '1 second') ON CONFLICT DO NOTHING",
      [
        `mistake-sync:${corrected.id}`,
        JSON.stringify({
          ...syncJob.payload,
          assessmentId: corrected.id,
        }),
      ],
    );
    await sync(
      jobFromRow({
        id: corrected.id,
        kind: "learning.mistake-sync",
        payload: { ...syncJob.payload, assessmentId: corrected.id },
      }),
      new AbortController().signal,
    );
    expect(
      (
        await db.pool.query(
          "SELECT lifecycle FROM student_mistakes WHERE id=$1",
          [mistake.id],
        )
      ).rows[0].lifecycle,
    ).toBe("revoked");
    const events = (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM mistake_state_events WHERE assessment_id=$1",
        [syncJob.payload.assessmentId],
      )
    ).rows[0].n;
    await sync(syncJob, new AbortController().signal);
    expect(
      (
        await db.pool.query(
          "SELECT lifecycle FROM student_mistakes WHERE id=$1",
          [mistake.id],
        )
      ).rows[0].lifecycle,
    ).toBe("revoked");
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM mistake_state_events WHERE assessment_id=$1",
          [syncJob.payload.assessmentId],
        )
      ).rows[0].n,
    ).toBe(events);
  }));

it("marks grading failed after repeated assessment failures and requeues on manual retry", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const { task, attempt } = await seed(db, f, "3");
    const item = (
      await db.pool.query(
        "SELECT id FROM task_items WHERE task_id=$1 ORDER BY position LIMIT 1",
        [task.id],
      )
    ).rows[0];
    const set = (
      await db.pool.query(
        "INSERT INTO practice_sets(task_id,generation_status,submission_status) VALUES($1,'ready','open') RETURNING id",
        [task.id],
      )
    ).rows[0];
    const submission = (
      await db.pool.query(
        "INSERT INTO practice_submissions(set_id,request_key,payload_hash) VALUES($1,'grading-retry',$2) RETURNING id",
        [set.id, "hash"],
      )
    ).rows[0];
    await db.pool.query(
      "INSERT INTO practice_submission_items(submission_id,task_item_id,attempt_id,grading_state) VALUES($1,$2,$3,'queued')",
      [submission.id, item.id, attempt.id],
    );
    await db.pool.query(
      "UPDATE jobs SET status='completed' WHERE kind<>'learning.assess'",
    );
    const queue = new JobQueue(db);
    let now = new Date(Date.now() + 1000);
    for (let i = 0; i < 3; i++) {
      const job = await queue.claim("worker", now);
      expect(job?.kind).toBe("learning.assess");
      await queue.fail(job!.id, job!.leaseToken, "PROCESSING_FAILED", now);
      now = new Date(now.getTime() + 60000);
    }
    const job = (
      await db.pool.query(
        "SELECT id FROM jobs WHERE kind='learning.assess' ORDER BY created_at LIMIT 1",
      )
    ).rows[0];
    expect(
      (
        await db.pool.query(
          "SELECT (SELECT status FROM jobs WHERE id=$1) AS job,(SELECT grading_state FROM practice_submission_items WHERE attempt_id=$2) AS grading",
          [job.id, attempt.id],
        )
      ).rows[0],
    ).toEqual({ job: "failed", grading: "failed" });

    expect(await queue.retry(job.id)).toBe(true);
    expect(
      (
        await db.pool.query(
          "SELECT (SELECT status FROM jobs WHERE id=$1) AS job,(SELECT grading_state FROM practice_submission_items WHERE attempt_id=$2) AS grading",
          [job.id, attempt.id],
        )
      ).rows[0],
    ).toEqual({ job: "queued", grading: "queued" });
  }));

it("projects an exhausted mistake sync lease as failed for the submission item", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const { task, attempt } = await seed(db, f, "3");
    const assessments = new AssessmentService(db, f.auth, f.catalog);
    await assessmentHandler(assessments)(
      await jobFor(db, "learning.assess"),
      new AbortController().signal,
    );
    const syncJob = await jobFor(db, "learning.mistake-sync");
    const item = (
      await db.pool.query(
        "SELECT id FROM task_items WHERE task_id=$1 ORDER BY position LIMIT 1",
        [task.id],
      )
    ).rows[0];
    const set = (
      await db.pool.query(
        "INSERT INTO practice_sets(task_id,generation_status,submission_status) VALUES($1,'ready','open') RETURNING id",
        [task.id],
      )
    ).rows[0];
    const submission = (
      await db.pool.query(
        "INSERT INTO practice_submissions(set_id,request_key,payload_hash) VALUES($1,'lease',$2) RETURNING id",
        [set.id, "hash"],
      )
    ).rows[0];
    await db.pool.query(
      "INSERT INTO practice_submission_items(submission_id,task_item_id,attempt_id,grading_state,mistake_sync_state) VALUES($1,$2,$3,'verified','queued')",
      [submission.id, item.id, attempt.id],
    );
    await db.pool.query(
      "UPDATE jobs SET status='completed',lease_token=NULL,lease_expires_at=NULL WHERE id<>$1",
      [syncJob.id],
    );
    await db.pool.query(
      "UPDATE jobs SET status='running',attempts=3,lease_token=gen_random_uuid(),lease_expires_at=now()-interval '1 minute' WHERE id=$1",
      [syncJob.id],
    );
    expect(await new JobQueue(db).claim("replacement", new Date())).toBeNull();
    expect(
      (
        await db.pool.query(
          "SELECT (SELECT status FROM jobs WHERE id=$1) AS job,(SELECT mistake_sync_state FROM practice_submission_items WHERE attempt_id=$2) AS mistake_sync",
          [syncJob.id, attempt.id],
        )
      ).rows[0],
    ).toEqual({ job: "failed", mistake_sync: "failed" });
  }));
