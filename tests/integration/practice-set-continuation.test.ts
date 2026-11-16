import { expect, it } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import type { Database } from "../../packages/db/src/client.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { PracticeSetService } from "../../apps/server/src/modules/learning/practice-sets.js";
import { AnswerSubmissionService } from "../../apps/server/src/modules/learning/answer-submission.js";
import { PracticeDraftService } from "../../apps/server/src/modules/learning/practice-drafts.js";
import { AssessmentService } from "../../apps/server/src/modules/learning/assessments.js";
import { MistakeService } from "../../apps/server/src/modules/learning/mistakes.js";
import { RunService } from "../../apps/server/src/modules/conversations/runs.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { assessmentHandler } from "../../apps/server/src/jobs/assessment-job.js";
import { mistakeSyncHandler } from "../../apps/server/src/jobs/mistake-sync-job.js";
import type { AnswerPayload } from "../../packages/contracts/src/question-presentation.js";
import { TEST_EXAM_PROFILE } from "../../apps/server/src/modules/question-bank/exam-profiles.js";

import { seedPracticeScope as seedKnowledge } from "../helpers/practice.js";

async function payloadFor(
  db: Database,
  itemId: string,
): Promise<AnswerPayload> {
  const row = (
    await db.pool.query<{
      question_type: string;
      answer_spec: Record<string, unknown>;
    }>(
      `SELECT v.question_type, v.answer_spec FROM task_items i
       JOIN question_versions v ON v.id=i.question_version_id WHERE i.id=$1`,
      [itemId],
    )
  ).rows[0]!;
  if (row.question_type === "single_choice") {
    const spec = row.answer_spec as { correctOptionId: string };
    return { kind: "choice", optionIds: [spec.correctOptionId] };
  }
  if (row.question_type === "fill_blank") {
    const spec = row.answer_spec as {
      blanks: { blankId: string; answer: string }[];
    };
    return {
      kind: "blanks",
      values: spec.blanks.map((blank) => ({
        blankId: blank.blankId,
        value: blank.answer,
      })),
    };
  }
  const spec = row.answer_spec as { referenceAnswer: string; rubric: string[] };
  return {
    kind: "worked",
    text: `${spec.rubric?.[0] ?? "计算"} ${spec.referenceAnswer}`,
    attachmentIds: [],
  };
}

async function completeSet(
  db: Database,
  f: Awaited<ReturnType<typeof catalogFixture>>,
  sets: PracticeSetService,
  setId: string,
) {
  const ready = await sets.generateAll(f.scope, setId);
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
  await submissions.submit(f.scope, ready.id, {
    requestKey: "complete",
    expectedVersion: ready.version,
    entries,
    skippedItemIds: [skip.itemId!],
    finalize: true,
  });
  const assess = assessmentHandler(
    new AssessmentService(db, f.auth, f.catalog),
  );
  const sync = mistakeSyncHandler(new MistakeService(db, f.auth));
  for (const job of (
    await db.pool.query<{
      id: string;
      kind: string;
      payload: Record<string, unknown>;
      attempts: number;
    }>("SELECT id,kind,payload,attempts FROM jobs WHERE kind='learning.assess'")
  ).rows)
    await assess({ ...job, leaseToken: "t" }, new AbortController().signal);
  for (const job of (
    await db.pool.query<{
      id: string;
      kind: string;
      payload: Record<string, unknown>;
      attempts: number;
    }>(
      "SELECT id,kind,payload,attempts FROM jobs WHERE kind='learning.mistake-sync'",
    )
  ).rows)
    await sync({ ...job, leaseToken: "t" }, new AbortController().signal);
  return sets.get(f.scope, setId);
}

it("rejects continue before completion and keeps a single successor", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const skillId = await seedKnowledge(db, f.admin.userId);
    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, { kind: "daily_practice" });
    const sets = new PracticeSetService(db, f.auth, tasks);
    const created = await sets.create(f.scope, task.id, {
      requestKey: "c1",
      skillIds: [skillId],
      mode: "step",
      strategy: "mixed",
    });
    await expect(
      sets.continue(f.scope, created.id, {
        requestKey: "next",
        expectedVersion: created.version,
      }),
    ).rejects.toMatchObject({ status: 409 });

    const ready = await sets.generateAll(f.scope, created.id);
    const drafts = new PracticeDraftService(db, f.auth, sets);
    const choice = ready.items.find(
      (item) => item.questionType === "single_choice",
    )!;
    await drafts.put(f.scope, created.id, choice.itemId!, {
      expectedVersion: 1,
      answer: {
        kind: "choice",
        optionIds:
          choice.presentation?.kind === "choice"
            ? [choice.presentation.options[0]!.optionId]
            : ["x"],
      },
    });
    const versionIds = ready.items.map((item) => item.questionVersionId);
    const switched = await sets.changeMode(f.scope, created.id, {
      expectedVersion: ready.version,
      mode: "batch",
    });
    expect(switched.mode).toBe("batch");
    expect(switched.items.map((item) => item.questionVersionId)).toEqual(
      versionIds,
    );
    expect((await drafts.list(f.scope, created.id)).length).toBeGreaterThan(0);

    const completed = await completeSet(db, f, sets, created.id);
    const [first, second] = await Promise.all([
      sets.continue(f.scope, completed.id, {
        requestKey: "k-a",
        expectedVersion: completed.version,
      }),
      sets.continue(f.scope, completed.id, {
        requestKey: "k-b",
        expectedVersion: completed.version,
      }),
    ]);
    expect(first.setId).toBe(second.setId);
    expect(first.taskId).not.toBe(completed.taskId);
    const nextReady = await sets.generateAll(f.scope, first.setId);
    expect(nextReady.generation).toBe("ready");
    expect(
      new Set([...ready.items, ...nextReady.items].map((i) => i.stem)).size,
    ).toBe(10);
    const replay = await sets.continue(f.scope, completed.id, {
      requestKey: "k-a",
      expectedVersion: 1,
    });
    expect(replay.setId).toBe(first.setId);
    await db.pool.query(
      "UPDATE practice_set_continuations SET payload_hash='other' WHERE previous_set_id=$1 AND request_key='k-a'",
      [completed.id],
    );
    await expect(
      sets.continue(f.scope, completed.id, {
        requestKey: "k-a",
        expectedVersion: completed.version,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const successor = await sets.get(f.scope, first.setId);
    expect(successor.mode).toBe("batch");
    expect(successor.strategy).toBe("mixed");
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM practice_sets WHERE previous_set_id=$1",
          [completed.id],
        )
      ).rows[0]!.n,
    ).toBe(1);

    await new MessageService(db, f.auth).append(f.scope, {
      conversationId: task.conversationId,
      role: "user",
      content: "这题为什么错？",
    });
    expect(
      (
        await db.pool.query("SELECT status FROM learning_tasks WHERE id=$1", [
          task.id,
        ])
      ).rows[0]!.status,
    ).toBe("completed");
    expect(
      (await db.pool.query("SELECT count(*)::int AS n FROM attempts")).rows[0]
        .n,
    ).toBe(4);
    await expect(
      new RunService(db, f.auth).submit(f.scope, {
        conversationId: task.conversationId,
        requestKey: "ask-2",
        message: "1",
        intent: "question",
        questionVersionId: completed.items[0]!.questionVersionId!,
      }),
    ).rejects.toMatchObject({ status: 422 });
  }));

it("rejects invalid exam profiles", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const skillId = await seedKnowledge(db, f.admin.userId);
    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, { kind: "daily_practice" });
    const sets = new PracticeSetService(db, f.auth, tasks);
    await expect(
      sets.create(f.scope, task.id, {
        requestKey: "exam-bad",
        skillIds: [skillId],
        mode: "step",
        strategy: "exam",
        examProfileId: "not-real",
      }),
    ).rejects.toMatchObject({ status: 422 });
    const ok = await sets.create(f.scope, task.id, {
      requestKey: "exam-ok",
      skillIds: [skillId],
      mode: "step",
      strategy: "exam",
      examProfileId: TEST_EXAM_PROFILE.profileId,
    });
    expect(ok.examProfileId).toBe(TEST_EXAM_PROFILE.profileId);
  }));
