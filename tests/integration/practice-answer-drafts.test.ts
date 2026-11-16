import { seedPracticeScope } from "../helpers/practice.js";
import { expect, it } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { PracticeSetService } from "../../apps/server/src/modules/learning/practice-sets.js";
import { PracticeDraftService } from "../../apps/server/src/modules/learning/practice-drafts.js";


it("keeps the newer draft when versions conflict", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const skillId = await seedPracticeScope(db, f.admin.userId);
    const tasks = new TaskService(db, f.auth, f.catalog);
    const task = await tasks.create(f.scope, { kind: "daily_practice" });
    const sets = new PracticeSetService(db, f.auth, tasks);
    const created = await sets.create(f.scope, task.id, {
    skillIds: [skillId],
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
