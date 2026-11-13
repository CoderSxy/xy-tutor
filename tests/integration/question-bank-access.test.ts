import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { JobQueue } from "../../apps/server/src/jobs/queue.js";
import { KnowledgeBaseService } from "../../apps/server/src/modules/knowledge-base/service.js";
import { SkillService } from "../../apps/server/src/modules/question-bank/skills.js";
import { QuestionBankService } from "../../apps/server/src/modules/question-bank/service.js";
import { searchEligibleQuestions } from "../../apps/server/src/modules/question-bank/search.js";
import type { Database } from "../../packages/db/src/client.js";
import type { Actor } from "../../packages/contracts/src/domain.js";

async function seedKnowledgeItem(
  c: Database,
  actorId: string,
  status: "pending_review" | "published" | "withdrawn",
  title = "分数加法",
) {
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
       VALUES($1,$2,$3,'同分母分数相加，分子相加分母不变',$4,${status === "pending_review" ? "NULL" : "now()"})
       RETURNING id`,
      [batchId, runId, title, status],
    )
  ).rows[0]!.id;
}

async function seedQuestionVersion(
  c: Database,
  studentId: string | null,
  stem = "1/4 + 1/4 = ?",
) {
  const questionId = (
    await c.pool.query<{ id: string }>(
      "INSERT INTO questions(student_id,source_type) VALUES($1,'private_upload') RETURNING id",
      [studentId],
    )
  ).rows[0]!.id;
  return (
    await c.pool.query<{ id: string }>(
      "INSERT INTO question_versions(question_id,version_no,stem,reference_answer) VALUES($1,1,$2,'1/2') RETURNING id",
      [questionId, stem],
    )
  ).rows[0]!.id;
}

async function secondStudent(f: Awaited<ReturnType<typeof catalogFixture>>) {
  const invitation = await f.auth.invite(f.admin, { login: "student2" });
  const activated = await f.auth.activate({
    token: invitation.activationToken,
    password: "long-test-password",
  });
  return { userId: activated.userId, studentId: activated.studentId! };
}

async function submitAndPublish(
  c: Database,
  bank: QuestionBankService,
  admin: Actor,
  entryId: string,
  version: number,
) {
  await c.pool.query(
    "UPDATE question_bank_entries SET status='pending_review',updated_at=now() WHERE id=$1",
    [entryId],
  );
  return bank.publish(admin, entryId, version);
}

async function entryInput(
  bankSkillId: string,
  questionVersionId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    questionVersionId,
    skillId: bankSkillId,
    difficultyBand: "easy" as const,
    complexityBand: 1,
    visibility: "owner_only" as const,
    sourceType: "private_upload" as const,
    ...overrides,
  };
}

it("拒绝让技能前置关系成环", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const skills = new SkillService(c);
    const fraction = await skills.create(f.admin, {
      code: "fraction_addition",
      name: "分数加法",
    });
    const denominator = await skills.create(f.admin, {
      code: "common_denominator",
      name: "通分",
    });
    await skills.setPrerequisites(f.admin, denominator.id, [fraction.id]);
    await expect(
      skills.setPrerequisites(f.admin, fraction.id, [denominator.id]),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
  }));

it("并发写前置也只能有一次成功，不形成环", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const skills = new SkillService(c);
    const a = await skills.create(f.admin, { code: "skill_a", name: "技能 A" });
    const b = await skills.create(f.admin, { code: "skill_b", name: "技能 B" });
    const results = await Promise.allSettled([
      skills.setPrerequisites(f.admin, a.id, [b.id]),
      skills.setPrerequisites(f.admin, b.id, [a.id]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "CONFLICT", status: 409 },
    });
  }));

it("未发布知识点不能作为技能依据，发布后才可关联", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const skills = new SkillService(c);
    const skill = await skills.create(f.admin, {
      code: "fraction_addition",
      name: "分数加法",
    });
    const itemId = await seedKnowledgeItem(c, f.admin.userId, "pending_review", "待确认");
    await expect(skills.linkContent(f.admin, skill.id, itemId)).rejects.toMatchObject(
      { code: "CONFLICT", status: 409 },
    );
    await c.pool.query(
      "UPDATE knowledge_items SET status='published',published_at=now() WHERE id=$1",
      [itemId],
    );
    await skills.linkContent(f.admin, skill.id, itemId);
  }));

it("学生不能调用技能管理接口", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const skills = new SkillService(c);
    await expect(
      skills.create(f.scope.actor, { code: "fraction_addition", name: "分数加法" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  }));

it("撤回知识点后关联技能不再提供候选题", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const skills = new SkillService(c);
    const bank = new QuestionBankService(c);
    const skill = await skills.create(f.admin, {
      code: "fraction_addition",
      name: "分数加法",
    });
    const itemId = await seedKnowledgeItem(c, f.admin.userId, "published");
    await skills.linkContent(f.admin, skill.id, itemId);
    const versionId = await seedQuestionVersion(c, null);
    const draft = await bank.createDraft(
      f.admin,
      await entryInput(skill.id, versionId, {
        visibility: "shared",
        sourceType: "shared_upload",
        knowledgeItemId: itemId,
      }),
    );
    await submitAndPublish(c, bank, f.admin, draft.id, draft.version);
    expect(
      await searchEligibleQuestions(c, f.scope, { skillId: skill.id, goal: "repair" }),
    ).toHaveLength(1);

    const knowledge = new KnowledgeBaseService(c, new JobQueue(c), false);
    await knowledge.withdrawItems(f.admin, [itemId]);
    expect(
      await searchEligibleQuestions(c, f.scope, { skillId: skill.id, goal: "repair" }),
    ).toHaveLength(0);
  }));

it("前置技能缺少已发布依据时不下发候选题", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const skills = new SkillService(c);
    const bank = new QuestionBankService(c);
    const base = await skills.create(f.admin, {
      code: "common_denominator",
      name: "通分",
    });
    const skill = await skills.create(f.admin, {
      code: "fraction_addition",
      name: "分数加法",
    });
    await skills.setPrerequisites(f.admin, skill.id, [base.id]);
    const itemId = await seedKnowledgeItem(c, f.admin.userId, "published");
    await skills.linkContent(f.admin, skill.id, itemId);
    const versionId = await seedQuestionVersion(c, null);
    const draft = await bank.createDraft(
      f.admin,
      await entryInput(skill.id, versionId, {
        visibility: "shared",
        sourceType: "shared_upload",
      }),
    );
    await submitAndPublish(c, bank, f.admin, draft.id, draft.version);
    expect(
      await searchEligibleQuestions(c, f.scope, { skillId: skill.id, goal: "repair" }),
    ).toHaveLength(0);

    const baseItem = await seedKnowledgeItem(c, f.admin.userId, "published", "通分");
    await skills.linkContent(f.admin, base.id, baseItem);
    expect(
      await searchEligibleQuestions(c, f.scope, { skillId: skill.id, goal: "repair" }),
    ).toHaveLength(1);
  }));

it("只按 skill 关联推荐，旧文本标签不自动视为同一技能", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const skills = new SkillService(c);
    const bank = new QuestionBankService(c);
    const a = await skills.create(f.admin, {
      code: "fraction_addition",
      name: "分数加法",
    });
    const b = await skills.create(f.admin, {
      code: "fraction_addition_word_problem",
      name: "分数加法应用题",
    });
    for (const skill of [a, b]) {
      const itemId = await seedKnowledgeItem(c, f.admin.userId, "published", skill.name);
      await skills.linkContent(f.admin, skill.id, itemId);
    }
    const versionId = await seedQuestionVersion(c, null, "分数加法 1/4+1/4=?");
    const draft = await bank.createDraft(
      f.admin,
      await entryInput(b.id, versionId, {
        visibility: "shared",
        sourceType: "shared_upload",
      }),
    );
    await submitAndPublish(c, bank, f.admin, draft.id, draft.version);
    expect(
      await searchEligibleQuestions(c, f.scope, { skillId: a.id, goal: "repair" }),
    ).toHaveLength(0);
    expect(
      await searchEligibleQuestions(c, f.scope, { skillId: b.id, goal: "repair" }),
    ).toHaveLength(1);
  }));

it("私人题只有本人可见，跨学生撤回返回 404", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const other = await secondStudent(f);
    const skills = new SkillService(c);
    const bank = new QuestionBankService(c);
    const skill = await skills.create(f.admin, {
      code: "fraction_addition",
      name: "分数加法",
    });
    const itemId = await seedKnowledgeItem(c, f.admin.userId, "published");
    await skills.linkContent(f.admin, skill.id, itemId);
    const versionId = await seedQuestionVersion(c, f.scope.studentId);
    const draft = await bank.createDraft(
      f.scope.actor,
      await entryInput(skill.id, versionId),
    );
    await submitAndPublish(c, bank, f.admin, draft.id, draft.version);

    expect(
      await searchEligibleQuestions(c, f.scope, { skillId: skill.id, goal: "repair" }),
    ).toHaveLength(1);
    expect(
      await searchEligibleQuestions(
        c,
        { actor: { userId: other.userId, role: "student" }, studentId: other.studentId },
        { skillId: skill.id, goal: "repair" },
      ),
    ).toHaveLength(0);
    await expect(
      bank.withdraw(
        { userId: other.userId, role: "student" },
        draft.id,
        "不是我的题",
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  }));

it("未准入的无主题不进入候选，owner_only 必须有所有者", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const skills = new SkillService(c);
    const bank = new QuestionBankService(c);
    const skill = await skills.create(f.admin, {
      code: "fraction_addition",
      name: "分数加法",
    });
    const itemId = await seedKnowledgeItem(c, f.admin.userId, "published");
    await skills.linkContent(f.admin, skill.id, itemId);
    const versionId = await seedQuestionVersion(c, null);
    await bank.createDraft(
      f.admin,
      await entryInput(skill.id, versionId, {
        visibility: "shared",
        sourceType: "shared_upload",
      }),
    );
    expect(
      await searchEligibleQuestions(c, f.scope, { skillId: skill.id, goal: "repair" }),
    ).toHaveLength(0);
    await expect(
      c.pool.query(
        `INSERT INTO question_bank_entries(question_version_id,difficulty_band,complexity_band,visibility,owner_id,source_type,content_fingerprint,created_by)
         VALUES($1,'easy',1,'owner_only',NULL,'private_upload','x',$2)`,
        [versionId, f.admin.userId],
      ),
    ).rejects.toThrow();
  }));

it("撤回题目后不再有候选", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const skills = new SkillService(c);
    const bank = new QuestionBankService(c);
    const skill = await skills.create(f.admin, {
      code: "fraction_addition",
      name: "分数加法",
    });
    const itemId = await seedKnowledgeItem(c, f.admin.userId, "published");
    await skills.linkContent(f.admin, skill.id, itemId);
    const versionId = await seedQuestionVersion(c, null);
    const draft = await bank.createDraft(
      f.admin,
      await entryInput(skill.id, versionId, {
        visibility: "shared",
        sourceType: "shared_upload",
      }),
    );
    await submitAndPublish(c, bank, f.admin, draft.id, draft.version);
    await bank.withdraw(
      f.admin,
      draft.id,
      "题目条件不严谨",
    );
    expect(
      await searchEligibleQuestions(c, f.scope, { skillId: skill.id, goal: "repair" }),
    ).toHaveLength(0);
  }));

it("私人题共享必须是管理员，并生成脱敏新版本且保留原 owner", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const skills = new SkillService(c);
    const bank = new QuestionBankService(c);
    const skill = await skills.create(f.admin, {
      code: "fraction_addition",
      name: "分数加法",
    });
    const versionId = await seedQuestionVersion(c, f.scope.studentId);
    const personal = await bank.createDraft(
      f.scope.actor,
      await entryInput(skill.id, versionId),
    );
    await expect(
      bank.createDraft(
        f.scope.actor,
        await entryInput(skill.id, versionId, {
          visibility: "shared",
          sourceType: "shared_upload",
        }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    const shared = await bank.createDraft(
      f.admin,
      await entryInput(skill.id, versionId, {
        visibility: "shared",
        sourceType: "shared_upload",
      }),
    );
    expect(shared.visibility).toBe("shared");
    expect(shared.ownerId).toBe(f.scope.studentId);
    expect(shared.questionVersionId).not.toBe(versionId);
    expect(shared.id).not.toBe(personal.id);
    const original = await c.pool.query<{ owner_id: string; visibility: string }>(
      "SELECT owner_id,visibility FROM question_bank_entries WHERE id=$1",
      [personal.id],
    );
    expect(original.rows[0]).toMatchObject({
      owner_id: f.scope.studentId,
      visibility: "owner_only",
    });
  }));

it("发布使用版本号防止覆盖他人审核", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const skills = new SkillService(c);
    const bank = new QuestionBankService(c);
    const skill = await skills.create(f.admin, {
      code: "fraction_addition",
      name: "分数加法",
    });
    const versionId = await seedQuestionVersion(c, null);
    const draft = await bank.createDraft(
      f.admin,
      await entryInput(skill.id, versionId, {
        visibility: "shared",
        sourceType: "shared_upload",
      }),
    );
    await c.pool.query(
      "UPDATE question_bank_entries SET status='pending_review',updated_at=now() WHERE id=$1",
      [draft.id],
    );
    await bank.publish(f.admin, draft.id, draft.version);
    await expect(bank.publish(f.admin, draft.id, draft.version)).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
  }));
