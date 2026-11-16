import { expect, it } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { PracticeSetService } from "../../apps/server/src/modules/learning/practice-sets.js";
import { PracticeDraftService } from "../../apps/server/src/modules/learning/practice-drafts.js";

async function seedKnowledge(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
  actorId: string,
) {
  const batchId = (
    await db.pool.query<{ id: string }>(
      "INSERT INTO knowledge_batches(actor_id) VALUES($1) RETURNING id",
      [actorId],
    )
  ).rows[0]!.id;
  const runId = (
    await db.pool.query<{ id: string }>(
      "INSERT INTO knowledge_parse_runs(batch_id,status) VALUES($1,'succeeded') RETURNING id",
      [batchId],
    )
  ).rows[0]!.id;
  await db.pool.query(
    `INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status,published_at)
     VALUES($1,$2,'有理数','加减运算','published',now())`,
    [batchId, runId],
  );
}

it("keeps the newer draft when versions conflict", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    await seedKnowledge(db, f.admin.userId);
    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, { kind: "daily_practice" });
    const sets = new PracticeSetService(db, f.auth, tasks);
    const created = await sets.create(f.scope, task.id, {
      requestKey: "draft-set",
      mode: "step",
      strategy: "mixed",
    });
    const ready = await sets.generateAll(f.scope, created.id);
    const choice = ready.items.find((item) => item.questionType === "single_choice")!;
    const optionId = choice.presentation?.kind === "choice"
      ? choice.presentation.options[0]!.optionId
      : "opt";
    const drafts = new PracticeDraftService(db, f.auth, sets);
    const first = await drafts.put(f.scope, created.id, choice.itemId!, {
      expectedVersion: 1,
      answer: { kind: "choice", optionIds: [optionId] },
    });
    expect(first.version).toBe(1);
    const newer = await drafts.put(f.scope, created.id, choice.itemId!, {
      expectedVersion: first.version,
      answer: { kind: "choice", optionIds: [optionId] },
    });
    await expect(
      drafts.put(f.scope, created.id, choice.itemId!, {
        expectedVersion: first.version,
        answer: { kind: "worked", text: "旧标签页", attachmentIds: [] },
      }),
    ).rejects.toMatchObject({ status: 409 });
    const listed = await drafts.list(f.scope, created.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.version).toBe(newer.version);
    expect(listed[0]!.answer).toEqual(newer.answer);
    expect(JSON.stringify(listed)).not.toContain("answerSpec");
  }));
