import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { PracticeSetService } from "../../apps/server/src/modules/learning/practice-sets.js";
import { PracticeService } from "../../apps/server/src/modules/learning/practice.js";
import { JobQueue } from "../../apps/server/src/jobs/queue.js";

import { seedPracticeScope as seedKnowledge } from "../helpers/practice.js";

it("creates one set per task and fills exactly five formal slots", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const skillId = await seedKnowledge(db, f.admin.userId);
    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, { kind: "daily_practice" });
    const sets = new PracticeSetService(db, f.auth, tasks, new JobQueue(db));
    const first = await sets.create(f.scope, task.id, {
      requestKey: "set-1",
      skillIds: [skillId],
      mode: "step",
      strategy: "mixed",
    });
    const again = await sets.create(f.scope, task.id, {
      requestKey: "set-1",
      skillIds: [skillId],
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
    const verified = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM question_references r JOIN task_items i ON i.question_version_id=r.question_version_id WHERE i.task_id=$1 AND r.verification='verified'`,
      [task.id],
    );
    expect(verified.rows[0]!.n).toBe(5);
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
    const skillId = await seedKnowledge(db, f.admin.userId);
    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, { kind: "daily_practice" });
    const sets = new PracticeSetService(db, f.auth, tasks);
    await sets.create(f.scope, task.id, {
      requestKey: "p1",
      skillIds: [skillId],
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

it("requires explicit scope even when unrelated published knowledge exists", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    await seedKnowledge(db, f.admin.userId);
    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, { kind: "daily_practice" });
    const sets = new PracticeSetService(db, f.auth, tasks);
    const set = await sets.create(f.scope, task.id, {
      requestKey: "unscoped",
      mode: "step",
      strategy: "mixed",
    });
    expect(set.generation).toBe("awaiting_scope");
    expect(
      (await sets.generateAll(f.scope, set.id)).items.every((i) => !i.stem),
    ).toBe(true);
  }));

it("never substitutes an unrelated template and recovers after scope confirmation", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const supported = await seedKnowledge(db, f.admin.userId);
    const unrelated = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO skills(code,name,created_by) VALUES('geometry','几何',$1) RETURNING id",
        [f.admin.userId],
      )
    ).rows[0]!.id;
    await db.pool.query(
      "INSERT INTO skill_content_links(skill_id,knowledge_item_id,created_by) SELECT $1,knowledge_item_id,$2 FROM skill_content_links WHERE skill_id=$3",
      [unrelated, f.admin.userId, supported],
    );
    const tasks = new TaskService(db, f.auth, f.catalog);
    const sets = new PracticeSetService(db, f.auth, tasks);
    const task = await tasks.create(f.scope, { kind: "daily_practice" });
    const created = await sets.create(f.scope, task.id, {
      requestKey: "geometry",
      mode: "step",
      strategy: "mixed",
      skillIds: [unrelated],
    });
    const missing = await sets.generateAll(f.scope, created.id);
    expect(missing.generation).toBe("insufficient_pool");
    expect(missing.items.every((i) => !i.stem)).toBe(true);
    await sets.retryGeneration(f.scope, created.id, {
      requestKey: "scope-fix",
      expectedVersion: missing.version,
      skillIds: [supported],
    });
    expect((await sets.generateAll(f.scope, created.id)).generation).toBe(
      "ready",
    );
  }));

it("uses the stored seed deterministically and produces distinct scoped stems", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const skill = await seedKnowledge(db, f.admin.userId);
    const tasks = new TaskService(db, f.auth, f.catalog);
    const sets = new PracticeSetService(db, f.auth, tasks);
    const create = async () =>
      sets.create(
        f.scope,
        (await tasks.create(f.scope, { kind: "daily_practice" })).id,
        {
          requestKey: "seed",
          mode: "step",
          strategy: "mixed",
          skillIds: [skill],
        },
      );
    const first = await create();
    await db.pool.query(
      "UPDATE practice_sets SET seed='fixed-seed' WHERE id=$1",
      [first.id],
    );
    const a = await sets.generateAll(f.scope, first.id);
    expect(new Set(a.items.map((i) => i.stem)).size).toBe(5);
    const second = await create();
    await db.pool.query(
      "UPDATE practice_sets SET seed='fixed-seed' WHERE id=$1",
      [second.id],
    );
    // Remove prior practice from the recent window to isolate deterministic generation.
    await db.pool.query(
      "UPDATE learning_tasks SET created_at=now()-interval '31 days' WHERE id=$1",
      [first.taskId],
    );
    await db.pool.query(
      "UPDATE practice_set_slots dst SET question_type=src.question_type FROM practice_set_slots src WHERE dst.set_id=$1 AND src.set_id=$2 AND dst.position=src.position",
      [second.id, first.id],
    );
    const b = await sets.generateAll(f.scope, second.id);
    expect(b.items.map((i) => i.stem)).toEqual(a.items.map((i) => i.stem));
  }));

it("lists scopes only when prerequisites are active and published", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const skill = await seedKnowledge(db, f.admin.userId);
    const prerequisite = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO skills(code,name,created_by) VALUES('prerequisite','前置技能',$1) RETURNING id",
        [f.admin.userId],
      )
    ).rows[0]!.id;
    await db.pool.query(
      "INSERT INTO skill_prerequisites(skill_id,prerequisite_id) VALUES($1,$2)",
      [skill, prerequisite],
    );
    const tasks = new TaskService(db, f.auth, f.catalog);
    const sets = new PracticeSetService(db, f.auth, tasks);
    expect((await sets.listScopes(f.scope)).map((s) => s.id)).not.toContain(
      skill,
    );
    await db.pool.query(
      "INSERT INTO skill_content_links(skill_id,knowledge_item_id,created_by) SELECT $1,knowledge_item_id,$2 FROM skill_content_links WHERE skill_id=$3",
      [prerequisite, f.admin.userId, skill],
    );
    expect((await sets.listScopes(f.scope)).map((s) => s.id)).toContain(skill);
    await db.pool.query("UPDATE skills SET status='withdrawn' WHERE id=$1", [
      prerequisite,
    ]);
    expect((await sets.listScopes(f.scope)).map((s) => s.id)).not.toContain(
      skill,
    );
  }));

it("generates safely with more than fifty recent question versions", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const skill = await seedKnowledge(db, f.admin.userId);
    const tasks = new TaskService(db, f.auth, f.catalog);
    const recent = await tasks.create(f.scope, { kind: "daily_practice" });
    const question = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO questions(student_id,source_type) VALUES($1,'practice') RETURNING id",
        [f.scope.studentId],
      )
    ).rows[0]!.id;
    await db.pool.query(
      `WITH versions AS (
      INSERT INTO question_versions(question_id,version_no,stem,reference_answer)
      SELECT $1,n,'历史题 ' || n,'0' FROM generate_series(1,51) n RETURNING id,version_no
    ) INSERT INTO task_items(task_id,question_version_id,position,role)
      SELECT $2,id,version_no,'original' FROM versions`,
      [question, recent.id],
    );
    const task = await tasks.create(f.scope, { kind: "daily_practice" });
    const sets = new PracticeSetService(db, f.auth, tasks);
    const set = await sets.create(f.scope, task.id, {
      requestKey: "large-history",
      mode: "step",
      strategy: "mixed",
      skillIds: [skill],
    });
    const ready = await sets.generateAll(f.scope, set.id);
    expect(ready.generation).toBe("ready");
    expect(new Set(ready.items.map((i) => i.stem)).size).toBe(5);
    expect(ready.items.every((i) => !i.stem?.startsWith("历史题"))).toBe(true);
  }));
