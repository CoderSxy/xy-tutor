import { seedPracticeScope } from "../helpers/practice.js";
import { expect, it } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import type { Database } from "../../packages/db/src/client.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { PracticeSetService } from "../../apps/server/src/modules/learning/practice-sets.js";
import { AnswerSubmissionService } from "../../apps/server/src/modules/learning/answer-submission.js";
import { PracticeDraftService } from "../../apps/server/src/modules/learning/practice-drafts.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { AssessmentService } from "../../apps/server/src/modules/learning/assessments.js";
import { MistakeService } from "../../apps/server/src/modules/learning/mistakes.js";
import { assessmentHandler } from "../../apps/server/src/jobs/assessment-job.js";
import { mistakeSyncHandler } from "../../apps/server/src/jobs/mistake-sync-job.js";
import type { PracticeSetDTO } from "../../packages/contracts/src/practice-sets.js";
import type { AnswerPayload } from "../../packages/contracts/src/question-presentation.js";


async function readySet(
  db: Database,
  f: Awaited<ReturnType<typeof catalogFixture>>,
) {
  const skillId = await seedPracticeScope(db, f.admin.userId);
  const tasks = new TaskService(db, f.auth, f.catalog);
  const task = await tasks.create(f.scope, { kind: "daily_practice" });
  const sets = new PracticeSetService(db, f.auth, tasks);
  const created = await sets.create(f.scope, task.id, {
    skillIds: [skillId],
    requestKey: "submit-set",
    mode: "batch",
    strategy: "mixed",
  });
  const ready = await sets.generateAll(f.scope, created.id);
  return { tasks, task, sets, ready };
}

async function payloadFor(
  db: Database,
  itemId: string,
  correct = true,
): Promise<AnswerPayload> {
  const row = (
    await db.pool.query<{
      question_type: string;
      answer_spec: Record<string, unknown>;
      presentation: { kind: string; options?: { optionId: string }[] };
    }>(
      `SELECT v.question_type, v.answer_spec, v.presentation
       FROM task_items i JOIN question_versions v ON v.id=i.question_version_id
       WHERE i.id=$1`,
      [itemId],
    )
  ).rows[0]!;
  if (row.question_type === "single_choice") {
    const spec = row.answer_spec as { correctOptionId: string };
    const other = row.presentation.options?.find(
      (option) => option.optionId !== spec.correctOptionId,
    );
    return {
      kind: "choice",
      optionIds: [
        correct
          ? spec.correctOptionId
          : (other?.optionId ?? spec.correctOptionId),
      ],
    };
  }
  if (row.question_type === "fill_blank") {
    const spec = row.answer_spec as {
      blanks: { blankId: string; answer: string }[];
    };
    return {
      kind: "blanks",
      values: spec.blanks.map((blank) => ({
        blankId: blank.blankId,
        value: correct ? blank.answer : "0",
      })),
    };
  }
  const spec = row.answer_spec as { referenceAnswer: string; rubric: string[] };
  return {
    kind: "worked",
    text: correct
      ? `${spec.rubric?.[0] ?? "计算"} ${spec.referenceAnswer}`
      : "我不会",
    attachmentIds: [],
  };
}

it("creates attempts and messages for step and batch submits and reuses the same key", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const { task, sets, ready } = await readySet(db, f);
    const submissions = new AnswerSubmissionService(db, f.auth, sets);
    const first = ready.items.find(
      (item) => item.questionType === "single_choice",
    )!;
    const step = await submissions.submit(f.scope, ready.id, {
      requestKey: "step-1",
      expectedVersion: ready.version,
      entries: [
        {
          itemId: first.itemId!,
          answer: await payloadFor(db, first.itemId!),
        },
      ],
      skippedItemIds: [],
      finalize: false,
    });
    expect(step.state).toBe("grading");
    expect(
      step.items.find((item) => item.itemId === first.itemId)?.submission,
    ).toBe("submitted");
    const attempt = (
      await db.pool.query<{ answer_payload: unknown; answer: string }>(
        "SELECT answer_payload, answer FROM attempts WHERE task_id=$1",
        [task.id],
      )
    ).rows[0];
    expect(attempt?.answer_payload).toMatchObject({ kind: "choice" });
    expect(attempt?.answer.length).toBeGreaterThan(0);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.task_id=$1 AND m.role='user'",
          [task.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM jobs WHERE kind='learning.assess'",
        )
      ).rows[0].n,
    ).toBe(1);

    const replay = await submissions.submit(f.scope, ready.id, {
      requestKey: "step-1",
      expectedVersion: ready.version,
      entries: [
        {
          itemId: first.itemId!,
          answer: await payloadFor(db, first.itemId!),
        },
      ],
      skippedItemIds: [],
      finalize: false,
    });
    expect(replay.id).toBe(step.id);
    await expect(
      submissions.submit(f.scope, ready.id, {
        requestKey: "step-1",
        expectedVersion: ready.version,
        entries: [
          {
            itemId: first.itemId!,
            answer: await payloadFor(db, first.itemId!, false),
          },
        ],
        skippedItemIds: [],
        finalize: false,
      }),
    ).rejects.toMatchObject({ status: 409 });
  }));

it("rolls back the whole batch when any item option blank or attachment is unauthorized", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const { ready, sets } = await readySet(db, f);
    const submissions = new AnswerSubmissionService(db, f.auth, sets);
    const choice = ready.items.find(
      (item) => item.questionType === "single_choice",
    )!;
    const blank = ready.items.find(
      (item) => item.questionType === "fill_blank",
    )!;
    const worked = ready.items.find((item) => item.questionType === "worked")!;
    const valid = await payloadFor(db, choice.itemId!);
    await expect(
      submissions.submit(f.scope, ready.id, {
        requestKey: "bad-item",
        expectedVersion: ready.version,
        entries: [
          { itemId: choice.itemId!, answer: valid },
          {
            itemId: "00000000-0000-4000-8000-000000000099",
            answer: valid,
          },
        ],
        skippedItemIds: [],
        finalize: false,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      submissions.submit(f.scope, ready.id, {
        requestKey: "bad-option",
        expectedVersion: ready.version,
        entries: [
          {
            itemId: choice.itemId!,
            answer: { kind: "choice", optionIds: ["not-an-option"] },
          },
        ],
        skippedItemIds: [],
        finalize: false,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      submissions.submit(f.scope, ready.id, {
        requestKey: "bad-blank",
        expectedVersion: ready.version,
        entries: [
          {
            itemId: blank.itemId!,
            answer: {
              kind: "blanks",
              values: [{ blankId: "nope", value: "1" }],
            },
          },
        ],
        skippedItemIds: [],
        finalize: false,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      submissions.submit(f.scope, ready.id, {
        requestKey: "bad-file",
        expectedVersion: ready.version,
        entries: [
          {
            itemId: worked.itemId!,
            answer: {
              kind: "worked",
              text: "过程",
              attachmentIds: ["00000000-0000-4000-8000-000000000088"],
            },
          },
        ],
        skippedItemIds: [],
        finalize: false,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM practice_submissions",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM attempts")).rows[0]
        .n,
    ).toBe(0);
  }));

it("retries only the failed item and ignores hints as attempts", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const { task, ready, sets } = await readySet(db, f);
    const submissions = new AnswerSubmissionService(db, f.auth, sets);
    const drafts = new PracticeDraftService(db, f.auth, sets);
    const choice = ready.items.find(
      (item) => item.questionType === "single_choice",
    )!;
    await drafts.put(f.scope, ready.id, choice.itemId!, {
      expectedVersion: 1,
      answer: await payloadFor(db, choice.itemId!),
    });
    await new MessageService(db, f.auth).append(f.scope, {
      conversationId: task.conversationId,
      role: "user",
      content: "这题怎么做？请老师讲一下。",
    });
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM attempts")).rows[0]
        .n,
    ).toBe(0);

    const submitted = await submissions.submit(f.scope, ready.id, {
      requestKey: "grade-1",
      expectedVersion: ready.version,
      entries: [
        {
          itemId: choice.itemId!,
          answer: await payloadFor(db, choice.itemId!),
        },
      ],
      skippedItemIds: [],
      finalize: false,
    });
    const other = ready.items.find(
      (item) =>
        item.itemId &&
        item.itemId !== choice.itemId &&
        item.questionType === "fill_blank",
    )!;
    const second = await submissions.submit(f.scope, ready.id, {
      requestKey: "grade-2",
      expectedVersion: (await sets.get(f.scope, ready.id)).version,
      entries: [
        {
          itemId: other.itemId!,
          answer: await payloadFor(db, other.itemId!),
        },
      ],
      skippedItemIds: [],
      finalize: false,
    });
    const failedAttempt = (
      await db.pool.query<{ id: string }>(
        "SELECT attempt_id AS id FROM practice_submission_items WHERE task_item_id=$1",
        [choice.itemId],
      )
    ).rows[0]!.id;
    await db.pool.query(
      "UPDATE practice_submission_items SET grading_state='failed',reason_code='ASSESSMENT_FAILED' WHERE task_item_id=$1",
      [choice.itemId],
    );
    await db.pool.query(
      "UPDATE jobs SET status='failed',error_code='ASSESSMENT_FAILED' WHERE kind='learning.assess' AND payload->>'attemptId'=$1",
      [failedAttempt],
    );
    const retried = await submissions.retry(f.scope, submitted.id, {
      requestKey: "retry-failed",
      itemIds: [choice.itemId!],
    });
    expect(
      retried.items.find((item) => item.itemId === choice.itemId)?.grading,
    ).toBe("queued");
    expect(
      (
        await db.pool.query<{ grading_state: string }>(
          "SELECT grading_state FROM practice_submission_items WHERE task_item_id=$1",
          [other.itemId],
        )
      ).rows[0]!.grading_state,
    ).toBe("queued");
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM attempts WHERE question_version_id=(SELECT question_version_id FROM task_items WHERE id=$1)",
          [choice.itemId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(second.id).not.toBe(submitted.id);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM practice_answer_drafts WHERE task_item_id=$1",
          [choice.itemId],
        )
      ).rows[0].n,
    ).toBe(0);
  }));

it("finalizes four verified answers and one skip then completes after sync", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const { task, ready, sets } = await readySet(db, f);
    const submissions = new AnswerSubmissionService(db, f.auth, sets);
    const skip = ready.items.find((item) => item.questionType === "worked")!;
    const entries = [];
    for (const item of ready.items) {
      if (item.itemId === skip.itemId) continue;
      entries.push({
        itemId: item.itemId!,
        answer: await payloadFor(db, item.itemId!),
      });
    }
    const submitted = await submissions.submit(f.scope, ready.id, {
      requestKey: "batch-final",
      expectedVersion: ready.version,
      entries,
      skippedItemIds: [skip.itemId!],
      finalize: true,
    });
    expect(
      submitted.items.filter((item) => item.submission === "skipped"),
    ).toHaveLength(1);
    const assessments = new AssessmentService(db, f.auth, f.catalog);
    const mistakes = new MistakeService(db, f.auth);
    const assess = assessmentHandler(assessments);
    const sync = mistakeSyncHandler(mistakes);
    const jobs = (
      await db.pool.query<{
        id: string;
        kind: string;
        payload: Record<string, unknown>;
        attempts: number;
      }>(
        "SELECT id,kind,payload,attempts FROM jobs WHERE kind='learning.assess'",
      )
    ).rows;
    expect(jobs).toHaveLength(4);
    for (const job of jobs) {
      await assess(
        {
          id: job.id,
          kind: job.kind,
          payload: job.payload,
          leaseToken: "test-lease",
          attempts: job.attempts,
        },
        new AbortController().signal,
      );
    }
    const syncJobs = (
      await db.pool.query<{
        id: string;
        kind: string;
        payload: Record<string, unknown>;
        attempts: number;
      }>(
        "SELECT id,kind,payload,attempts FROM jobs WHERE kind='learning.mistake-sync'",
      )
    ).rows;
    for (const job of syncJobs)
      await sync(
        {
          id: job.id,
          kind: job.kind,
          payload: job.payload,
          leaseToken: "test-lease",
          attempts: job.attempts,
        },
        new AbortController().signal,
      );
    const loaded: PracticeSetDTO = await sets.get(f.scope, ready.id);
    expect(loaded.counts.skipped).toBe(1);
    expect(loaded.counts.verified).toBe(4);
    expect(loaded.canContinue).toBe(true);
    expect(loaded.submission).toBe("completed");
    expect(JSON.stringify(loaded)).not.toContain("answerSpec");
    expect(JSON.stringify(loaded)).not.toContain("referenceAnswer");
    const taskRow = (
      await db.pool.query<{ status: string }>(
        "SELECT status FROM learning_tasks WHERE id=$1",
        [task.id],
      )
    ).rows[0]!;
    expect(taskRow.status).toBe("completed");
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM jobs WHERE kind='learning.summary'",
        )
      ).rows[0].n,
    ).toBe(1);
    const fetched = await submissions.get(f.scope, submitted.id);
    expect(fetched.id).toBe(submitted.id);
  }));

it("finalizes remaining items using previously submitted progress without resetting reused grading", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const { ready, sets } = await readySet(db, f);
    const submissions = new AnswerSubmissionService(db, f.auth, sets);
    const first = ready.items.find(item => item.questionType === "fill_blank")!;
    const answer = await payloadFor(db, first.itemId!);
    await submissions.submit(f.scope, ready.id, {
      requestKey: "prior-step",
      expectedVersion: ready.version,
      entries: [{ itemId: first.itemId!, answer }],
      skippedItemIds: [],
      finalize: false,
    });
    await db.pool.query(
      "UPDATE practice_submission_items SET grading_state='verified' WHERE task_item_id=$1",
      [first.itemId],
    );
    const final = await submissions.submit(f.scope, ready.id, {
      requestKey: "remaining-final",
      expectedVersion: (await sets.get(f.scope, ready.id)).version,
      entries: [],
      skippedItemIds: ready.items.filter(item => item.itemId !== first.itemId).map((item) => item.itemId!),
      finalize: true,
    });
    expect(final.state).toBe("completed");
    await submissions.submit(f.scope, ready.id, {
      requestKey: "reuse-final",
      expectedVersion: (await sets.get(f.scope, ready.id)).version,
      entries: [{ itemId: first.itemId!, answer }],
      skippedItemIds: [],
      finalize: true,
    });
    const rows = (
      await db.pool.query(
        "SELECT grading_state FROM practice_submission_items WHERE task_item_id=$1",
        [first.itemId],
      )
    ).rows;
    expect(rows.every((row) => row.grading_state === "verified")).toBe(true);
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM attempts")).rows[0]
        .n,
    ).toBe(1);
  }));

it("retries pending assessment and failed mistake sync through separate jobs", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const { ready, sets } = await readySet(db, f);
    const submissions = new AnswerSubmissionService(db, f.auth, sets);
    const choices = ready.items
      .filter((item) => item.questionType === "single_choice")
      .slice(0, 2);
    const entries = await Promise.all(
      choices.map(async (item) => ({
        itemId: item.itemId!,
        answer: await payloadFor(db, item.itemId!, false),
      })),
    );
    const submitted = await submissions.submit(f.scope, ready.id, {
      requestKey: "retry-states",
      expectedVersion: ready.version,
      entries,
      skippedItemIds: [],
      finalize: false,
    });
    const assessments = new AssessmentService(db, f.auth, f.catalog);
    for (const row of (
      await db.pool.query(
        "SELECT attempt_id FROM practice_submission_items WHERE submission_id=$1",
        [submitted.id],
      )
    ).rows)
      await assessments.assessAttempt(f.scope, row.attempt_id);
    await db.pool.query(
      "UPDATE jobs SET status='completed' WHERE kind='learning.assess'",
    );
    await db.pool.query(
      "UPDATE practice_submission_items SET grading_state='pending' WHERE task_item_id=$1",
      [choices[0]!.itemId],
    );
    await db.pool.query(
      "UPDATE practice_submission_items SET grading_state='verified',mistake_sync_state='failed' WHERE task_item_id=$1",
      [choices[1]!.itemId],
    );
    await db.pool.query(
      "UPDATE jobs SET status='failed' WHERE kind='learning.mistake-sync'",
    );
    const result = await submissions.retry(f.scope, submitted.id, {
      requestKey: "recover-states",
      itemIds: choices.map((item) => item.itemId!),
    });
    expect(
      result.items.find((item) => item.itemId === choices[0]!.itemId)?.grading,
    ).toBe("queued");
    expect(
      result.items.find((item) => item.itemId === choices[1]!.itemId),
    ).toMatchObject({ grading: "verified", mistakeSync: "queued" });
    const assessmentJobs = (
      await db.pool.query(
        "SELECT status,payload FROM jobs WHERE kind='learning.assess'",
      )
    ).rows;
    expect(
      assessmentJobs.filter((job) => job.status === "queued"),
    ).toHaveLength(1);
    expect(
      assessmentJobs.find((job) => job.status === "queued").payload
        .forceReassessment,
    ).toBe(true);
    const syncJobs = (
      await db.pool.query(
        "SELECT status FROM jobs WHERE kind='learning.mistake-sync'",
      )
    ).rows;
    expect(syncJobs.filter((job) => job.status === "queued")).toHaveLength(1);
  }));
