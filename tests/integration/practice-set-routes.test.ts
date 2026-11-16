import { expect, it } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { sessionCookie } from "../helpers/student-insights.js";
import { buildApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { PracticeSetService } from "../../apps/server/src/modules/learning/practice-sets.js";
import type { Database } from "../../packages/db/src/client.js";

const password = "long-test-password";
const config = loadConfig({ NODE_ENV: "test" });

async function seedKnowledge(db: Database, actorId: string) {
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

it("keeps existing sets usable when the create flag is off", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    await seedKnowledge(db, f.admin.userId);
    const token = (await f.auth.login({ login: "student", password })).sessionToken;
    expect(config.features.practiceSetsEnabled).toBe(false);
    const app = buildApp({ database: db, config });
    const caps = await app.inject({
      method: "GET",
      url: "/api/capabilities",
      headers: { ...sessionCookie(token), origin: config.origin },
    });
    expect(caps.json().practiceSets).toBe("disabled");
    expect(caps.json().mobileStudy).toBe("disabled");

    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, { kind: "daily_practice" });
    const blocked = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/practice-set`,
      headers: { ...sessionCookie(token), origin: config.origin },
      payload: { requestKey: "http-1", mode: "batch", strategy: "mixed" },
    });
    expect(blocked.statusCode).toBe(409);

    const sets = new PracticeSetService(db, f.auth, tasks);
    const created = await sets.create(f.scope, task.id, {
      requestKey: "direct",
      mode: "batch",
      strategy: "mixed",
    });
    const ready = await sets.generateAll(f.scope, created.id);
    const fetched = await app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}/practice-set`,
      headers: { ...sessionCookie(token), origin: config.origin },
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().id).toBe(ready.id);
    expect(JSON.stringify(fetched.json())).not.toContain("answerSpec");

    const resultsOpen = await app.inject({
      method: "GET",
      url: `/api/practice-sets/${ready.id}/results`,
      headers: { ...sessionCookie(token), origin: config.origin },
    });
    expect(resultsOpen.statusCode).toBe(200);
    expect(
      resultsOpen.json().items.every((item: { correctness: unknown }) => item.correctness === null),
    ).toBe(true);

    const choice = ready.items.find((item) => item.questionType === "single_choice")!;
    const spec = (
      await db.pool.query<{ answer_spec: { correctOptionId: string } }>(
        `SELECT v.answer_spec FROM task_items i JOIN question_versions v ON v.id=i.question_version_id WHERE i.id=$1`,
        [choice.itemId],
      )
    ).rows[0]!.answer_spec;
    const submitted = await app.inject({
      method: "POST",
      url: `/api/practice-sets/${ready.id}/submit`,
      headers: { ...sessionCookie(token), origin: config.origin },
      payload: {
        requestKey: "route-submit",
        expectedVersion: ready.version,
        entries: [
          {
            itemId: choice.itemId,
            answer: { kind: "choice", optionIds: [spec.correctOptionId] },
          },
        ],
        skippedItemIds: [],
        finalize: false,
      },
    });
    expect(submitted.statusCode).toBe(202);
    expect(submitted.json().items[0]?.submission).toBe("submitted");

    const prefs = await app.inject({
      method: "GET",
      url: "/api/practice-preferences",
      headers: { ...sessionCookie(token), origin: config.origin },
    });
    expect(prefs.statusCode).toBe(200);
    expect(prefs.json().mode).toBeNull();
  }));
