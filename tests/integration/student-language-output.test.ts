import { it, expect } from "vitest";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { RunService } from "../../apps/server/src/modules/conversations/runs.js";
import { ModelGateway } from "../../apps/server/src/agent/provider.js";
import { ModelBudget } from "../../apps/server/src/agent/model-budget.js";
import { TutorExecutor } from "../../apps/server/src/agent/tutor.js";
import {
  ensureStudentContent,
  localizeQuestionStem,
} from "../../apps/server/src/modules/question-bank/student-language.js";

function gatewayWith(text: string) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(text)]);
  return new ModelGateway(
    { models, model: faux.getModel() },
    new ModelBudget(),
  );
}

it("repairs English student fields once without changing math", async () => {
  const repaired = await ensureStudentContent(
    {
      fields: { stem: "Find the period of y = sin x." },
      immutableMath: ["sin x"],
    },
    gatewayWith(JSON.stringify({ stem: "求 y=sin x 的周期。" })),
  );
  expect(repaired.status).toBe("accepted");
  expect(repaired.policyVersion).toBe("zh-student-v1");
  expect(repaired.fields.stem).toBe("求 y=sin x 的周期。");
  expect(JSON.stringify(repaired)).not.toMatch(/systemPrompt/);
});

it("rejects a language repair that changes the math condition", async () => {
  const repaired = await ensureStudentContent(
    {
      fields: { stem: "Find the period of y = sin x." },
      immutableMath: ["sin x"],
    },
    gatewayWith(JSON.stringify({ stem: "求 y=cos x 的周期。" })),
  );
  expect(repaired.status).toBe("repair_required");
  expect(repaired.reasonCodes).toContain("MATH_CHANGED");
  expect(repaired.fields.stem).toBe("Find the period of y = sin x.");
});

it("does not stream or persist unchecked English tutor text", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const revision = await f.publish("人教版", "周期");
    const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: revision.id,
      kind: "free_question",
    });
    const runs = new RunService(db, f.auth);
    const { runId } = await runs.submit(f.scope, {
      conversationId: task.conversationId,
      requestKey: "lang-1",
      message: "下一题",
    });
    await new TutorExecutor(
      db,
      f.auth,
      f.catalog,
      runs,
      gatewayWith("Please calculate the period of y = sin x. 求这个函数的周期。"),
    ).execute(runId, new AbortController().signal);
    const status = await runs.get(f.scope, runId);
    expect(status.content).not.toMatch(/Please calculate/);
    expect(status.content).toContain("求这个函数的周期");
    const events = await runs.events.readAfter(f.scope, runId);
    expect(JSON.stringify(events)).not.toMatch(/Please calculate/);
    const saved = (
      await db.pool.query<{ content: string }>(
        "SELECT content FROM message_versions ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0]!.content;
    expect(saved).toBe(status.content);
  }));

it("caches a Chinese display for historical stems without rewriting evidence", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const question = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO questions(student_id,source_type) VALUES($1,'practice') RETURNING id",
        [f.scope.studentId],
      )
    ).rows[0]!;
    const version = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO question_versions(question_id,version_no,stem,reference_answer,verification) VALUES($1,1,$2,'2π','verified') RETURNING id",
        [question.id, "Find the period of y = sin x."],
      )
    ).rows[0]!;
    const result = await localizeQuestionStem(
      db,
      version.id,
      gatewayWith(JSON.stringify({ stem: "求 y=sin x 的周期。" })),
    );
    expect(result.status).toBe("ready");
    expect(result.stem).toBe("求 y=sin x 的周期。");
    expect(result.originalUnchanged).toBe(true);
    const original = (
      await db.pool.query<{ stem: string }>(
        "SELECT stem FROM question_versions WHERE id=$1",
        [version.id],
      )
    ).rows[0]!.stem;
    expect(original).toBe("Find the period of y = sin x.");
  }));
