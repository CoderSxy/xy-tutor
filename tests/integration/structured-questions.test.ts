import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { searchEligibleQuestions } from "../../apps/server/src/modules/question-bank/search.js";
import { SkillService } from "../../apps/server/src/modules/question-bank/skills.js";
import { QuestionBankService } from "../../apps/server/src/modules/question-bank/service.js";
import {
  toPublicQuestion,
  verifyStructuredAnswer,
} from "../../apps/server/src/modules/question-bank/presentation.js";
import { instantiateTemplate } from "../../apps/server/src/modules/question-bank/templates.js";
import type { Database } from "../../packages/db/src/client.js";

async function seedKnowledge(c: Database, actorId: string) {
  const batchId = (
    await c.pool.query<{ id: string }>(
      "INSERT INTO knowledge_batches(actor_id) VALUES($1) RETURNING id",
      [actorId],
    )
  ).rows[0]!.id;
  const runId = (
    await c.pool.query<{ id: string }>(
      "INSERT INTO knowledge_parse_runs(batch_id,status) VALUES($1,'succeeded') RETURNING id",
      [batchId],
    )
  ).rows[0]!.id;
  return (
    await c.pool.query<{ id: string }>(
      `INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status,published_at)
       VALUES($1,$2,'分数加法','同分母分数相加', 'published', now()) RETURNING id`,
      [batchId, runId],
    )
  ).rows[0]!.id;
}

it("verifies structured answers and strips private fields from public JSON", async () =>
  withTestDb(async (db) => {
    const generated = instantiateTemplate("rational_arithmetic", 1, {
      a: 1,
      b: 2,
      c: 1,
      d: 2,
      op: "+",
      form: "single_choice",
    });
    const question = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO questions(source_type) VALUES('bank') RETURNING id",
      )
    ).rows[0]!;
    const version = (
      await db.pool.query<{ id: string }>(
        `INSERT INTO question_versions(question_id,version_no,stem,reference_answer,question_type,presentation,answer_spec)
         VALUES($1,1,$2,$3,$4,$5::jsonb,$6::jsonb) RETURNING id`,
        [
          question.id,
          generated.stem,
          generated.answer,
          generated.questionType,
          JSON.stringify(generated.presentation),
          JSON.stringify(generated.answerSpec),
        ],
      )
    ).rows[0]!;
    const correctId =
      generated.answerSpec && generated.answerSpec.kind === "single_choice"
        ? generated.answerSpec.correctOptionId
        : "";
    const result = await verifyStructuredAnswer(db, version.id, {
      kind: "choice",
      optionIds: [correctId],
    });
    expect(result.correctness).toBe("correct");
    const publicQuestion = toPublicQuestion({
      id: version.id,
      stem: generated.stem,
      questionType: generated.questionType,
      knowledgePoint: null,
      presentation: generated.presentation,
      answerSpec: generated.answerSpec,
      referenceAnswer: generated.answer,
      rubric: ["secret"],
    });
    expect(JSON.stringify(publicQuestion)).not.toContain("secret");
    expect(JSON.stringify(publicQuestion)).not.toContain("answerSpec");
    expect(JSON.stringify(publicQuestion)).not.toContain("referenceAnswer");
  }));

it("filters bank search by question type in SQL", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const skills = new SkillService(c);
    const bank = new QuestionBankService(c);
    const skill = await skills.create(f.admin, {
      code: "fractions_add",
      name: "分数加法",
    });
    const itemId = await seedKnowledge(c, f.admin.userId);
    await skills.linkContent(f.admin, skill.id, itemId);
    const created: { type: string; versionId: string }[] = [];
    for (const form of ["single_choice", "fill_blank"] as const) {
      const generated = instantiateTemplate("rational_arithmetic", 1, {
        a: 1,
        b: 2,
        c: 1,
        d: 2,
        op: "+",
        form,
      });
      const question = (
        await c.pool.query<{ id: string }>(
          "INSERT INTO questions(source_type) VALUES('bank') RETURNING id",
        )
      ).rows[0]!;
      const version = (
        await c.pool.query<{ id: string }>(
          `INSERT INTO question_versions(question_id,version_no,stem,reference_answer,question_type,presentation,answer_spec,verification)
           VALUES($1,1,$2,$3,$4,$5::jsonb,$6::jsonb,'verified') RETURNING id`,
          [
            question.id,
            generated.stem,
            generated.answer,
            generated.questionType,
            JSON.stringify(generated.presentation),
            JSON.stringify(generated.answerSpec),
          ],
        )
      ).rows[0]!;
      const draft = await bank.createDraft(f.admin, {
        questionVersionId: version.id,
        skillId: skill.id,
        difficultyBand: "easy",
        complexityBand: 1,
        visibility: "shared",
        sourceType: "template",
        templateFamily: "rational_arithmetic",
        knowledgeItemId: itemId,
      });
      await c.pool.query(
        "UPDATE question_bank_entries SET status='pending_review' WHERE id=$1",
        [draft.id],
      );
      await bank.publish(f.admin, draft.id, draft.version);
      created.push({ type: generated.questionType, versionId: version.id });
    }
    const choices = await searchEligibleQuestions(c, f.scope, {
      skillId: skill.id,
      goal: "repair",
      answerType: "single_choice",
    });
    expect(choices.map((row) => row.questionVersionId)).toEqual([
      created.find((row) => row.type === "single_choice")!.versionId,
    ]);
    const blanks = await searchEligibleQuestions(c, f.scope, {
      skillId: skill.id,
      goal: "repair",
      answerType: "fill_blank",
    });
    expect(blanks.map((row) => row.questionVersionId)).toEqual([
      created.find((row) => row.type === "fill_blank")!.versionId,
    ]);
  }));
