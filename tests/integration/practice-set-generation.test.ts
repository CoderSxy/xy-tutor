import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { PracticeSetService } from "../../apps/server/src/modules/learning/practice-sets.js";
import { PracticeService } from "../../apps/server/src/modules/learning/practice.js";
import { JobQueue } from "../../apps/server/src/jobs/queue.js";

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

it("creates one set per task and fills exactly five formal slots", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    await seedKnowledge(db, f.admin.userId);
    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, { kind: "daily_practice" });
    const sets = new PracticeSetService(db, f.auth, tasks, new JobQueue(db));
    const first = await sets.create(f.scope, task.id, {
      requestKey: "set-1",
      mode: "step",
      strategy: "mixed",
    });
    const again = await sets.create(f.scope, task.id, {
      requestKey: "set-1",
      mode: "step",
      strategy: "mixed",
    });
    expect(again.id).toBe(first.id);
    expect(first.items).toHaveLength(5);
    expect(first.items.map((item) => item.position)).toEqual([0, 1, 2, 3, 4]);
    const types = first.items.map((item) => item.questionType);
    expect(types.filter((type) => type === "single_choice")).toHaveLength(2);
    expect(types.filter((type) => type === "fill_blank")).toHaveLength(2);
    expect(types.filter((type) => type === "worked")).toHaveLength(1);

    const ready = await sets.generateAll(f.scope, first.id);
    expect(ready.generation).toBe("ready");
    expect(ready.items.every((item) => item.itemId && item.stem)).toBe(true);
    expect(JSON.stringify(ready)).not.toContain("answerSpec");
    expect(JSON.stringify(ready)).not.toContain("referenceAnswer");

    await expect(
      tasks.addQuestion(f.scope, task.id, {
        stem: "额外第六题",
        referenceAnswer: "1",
        role: "original",
      }),
    ).rejects.toMatchObject({ status: 409 });

    const diagnostic = await tasks.addQuestion(f.scope, task.id, {
      stem: "诊断微题：1+1=?",
      referenceAnswer: "2",
      role: "diagnostic",
    });
    expect(diagnostic.questionVersionId).toBeTruthy();
    const formal = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM practice_set_slots WHERE set_id=$1",
      [first.id],
    );
    expect(formal.rows[0]!.n).toBe(5);

    const [a, b] = await Promise.all([
      sets.fillSlot(f.scope, first.id, 0),
      sets.fillSlot(f.scope, first.id, 0),
    ]);
    expect(a.items[0]!.itemId).toBe(b.items[0]!.itemId);
  }));

it("returns awaiting_scope when no published knowledge exists", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, { kind: "daily_practice" });
    const sets = new PracticeSetService(db, f.auth, tasks);
    const created = await sets.create(f.scope, task.id, {
      requestKey: "scope-1",
      mode: "batch",
      strategy: "mixed",
    });
    expect(created.generation).toBe("awaiting_scope");
    expect(created.items.every((item) => item.stem === null)).toBe(true);
  }));

it("does not let propose_practice append a sixth formal question", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    await seedKnowledge(db, f.admin.userId);
    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, { kind: "daily_practice" });
    const sets = new PracticeSetService(db, f.auth, tasks);
    await sets.create(f.scope, task.id, {
      requestKey: "p1",
      mode: "step",
      strategy: "mixed",
    });
    const practice = new PracticeService(db, tasks);
    const result = await practice.propose(f.scope, task.id, {
      stem: "额外题",
      referenceAnswer: "1",
      knowledgePoint: "有理数",
      role: "original",
    });
    expect(result.status).toBe("pending");
    expect(result.reason).toContain("本题组");
  }));
