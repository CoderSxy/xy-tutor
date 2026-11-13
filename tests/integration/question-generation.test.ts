import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { JobQueue } from "../../apps/server/src/jobs/queue.js";
import { SkillService } from "../../apps/server/src/modules/question-bank/skills.js";
import { QuestionGenerationService } from "../../apps/server/src/modules/question-bank/generator.js";
import { searchEligibleQuestions } from "../../apps/server/src/modules/question-bank/search.js";
import type { ModelGateway } from "../../apps/server/src/agent/provider.js";
import type {
  ModelRequest,
  ModelResult,
} from "../../packages/contracts/src/agent.js";
import type { Database } from "../../packages/db/src/client.js";

type Complete = (
  request: ModelRequest,
  signal: AbortSignal,
) => Promise<ModelResult>;

function gateway(complete: Complete): ModelGateway {
  return {
    complete,
    runtime: { model: { id: "test-model" } },
  } as unknown as ModelGateway;
}

function reply(content: unknown): ModelResult {
  return { text: JSON.stringify(content), toolCalls: [] };
}

async function secondStudent(f: Awaited<ReturnType<typeof catalogFixture>>) {
  const invitation = await f.auth.invite(f.admin, { login: "student2" });
  const activated = await f.auth.activate({
    token: invitation.activationToken,
    password: "long-test-password",
  });
  return { userId: activated.userId, studentId: activated.studentId! };
}

async function seedSkillWithKnowledge(
  c: Database,
  adminId: string,
  code = "fraction_addition",
) {
  const skills = new SkillService(c);
  const skill = await skills.create(
    { userId: adminId, role: "admin" },
    { code, name: "分数加法" },
  );
  const batchId = (
    await c.pool.query<{ id: string }>(
      "INSERT INTO knowledge_batches(actor_id) VALUES($1) RETURNING id",
      [adminId],
    )
  ).rows[0]!.id;
  const runId = (
    await c.pool.query<{ id: string }>(
      "INSERT INTO knowledge_parse_runs(batch_id,status) VALUES($1,'succeeded') RETURNING id",
      [batchId],
    )
  ).rows[0]!.id;
  const itemId = (
    await c.pool.query<{ id: string }>(
      `INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status,published_at)
       VALUES($1,$2,'分数加法','同分母分数相加，分子相加分母不变','published',now())
       RETURNING id`,
      [batchId, runId],
    )
  ).rows[0]!.id;
  await skills.linkContent({ userId: adminId, role: "admin" }, skill.id, itemId);
  return { skill, itemId, skills };
}

async function seedTemplate(
  c: Database,
  adminId: string,
  input: {
    family: string;
    skillId: string;
    params: Record<string, unknown>;
    status?: "pending_review" | "approved" | "rejected";
  },
) {
  const approved = input.status === "approved";
  return (
    await c.pool.query<{ id: string }>(
      `INSERT INTO question_templates(
         family,skill_id,difficulty_band,params,version,status,approved_by,approved_at,created_by)
       VALUES($1,$2,'easy',$3,1,$4,$5,$6,$7) RETURNING id`,
      [
        input.family,
        input.skillId,
        JSON.stringify(input.params),
        input.status ?? "pending_review",
        approved ? adminId : null,
        approved ? new Date() : null,
        adminId,
      ],
    )
  ).rows[0]!.id;
}

async function runRow(c: Database, runId: string) {
  return (
    await c.pool.query<{
      status: string;
      error_code: string | null;
      result_entry_id: string | null;
      knowledge_evidence: unknown;
    }>(
      "SELECT status,error_code,result_entry_id,knowledge_evidence FROM question_generation_runs WHERE id=$1",
      [runId],
    )
  ).rows[0]!;
}

async function entryRow(c: Database, entryId: string) {
  return (
    await c.pool.query<{
      status: string;
      visibility: string;
      owner_id: string | null;
      source_type: string;
      template_family: string | null;
    }>(
      "SELECT status,visibility,owner_id,source_type,template_family FROM question_bank_entries WHERE id=$1",
      [entryId],
    )
  ).rows[0]!;
}

it("线性模板系数为 0 时拒绝生成", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const { skill } = await seedSkillWithKnowledge(c, f.admin.userId);
    await seedTemplate(c, f.admin.userId, {
      family: "linear_equation",
      skillId: skill.id,
      params: { a: 0, b: 1, c: 4 },
      status: "approved",
    });
    const service = new QuestionGenerationService(c, new JobQueue(c));
    const { runId } = await service.enqueue(f.scope, {
      skillId: skill.id,
      templateCode: "linear_equation",
      goal: "repair",
      requestKey: "zero-coefficient",
    });
    const result = await service.generate(runId);
    expect(result.status).toBe("failed");
    const run = await runRow(c, runId);
    expect(run.status).toBe("failed");
    expect(run.error_code).toBe("ZERO_COEFFICIENT");
    expect(run.result_entry_id).toBeNull();
  }));

it("模型超时不发布题目并记录 MODEL_TIMEOUT", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const { skill } = await seedSkillWithKnowledge(c, f.admin.userId);
    const slow = gateway(async () => {
      throw new Error("aborted");
    });
    const service = new QuestionGenerationService(c, new JobQueue(c), slow);
    const { runId } = await service.enqueue(f.scope, {
      skillId: skill.id,
      templateCode: "llm",
      goal: "diagnostic",
      requestKey: "model-timeout",
    });
    const result = await service.generate(runId);
    expect(result.status).toBe("failed");
    const run = await runRow(c, runId);
    expect(run.error_code).toBe("MODEL_TIMEOUT");
    expect(run.result_entry_id).toBeNull();
    const entries = await c.pool.query(
      "SELECT id FROM question_bank_entries",
    );
    expect(entries.rowCount).toBe(0);
  }));

it("缺少已发布资料依据时返回 insufficient_evidence 且不入队", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const skills = new SkillService(c);
    const skill = await skills.create(f.admin, {
      code: "fraction_addition",
      name: "分数加法",
    });
    const service = new QuestionGenerationService(c, new JobQueue(c));
    const result = await service.enqueue(f.scope, {
      skillId: skill.id,
      templateCode: "rational_arithmetic",
      goal: "repair",
      requestKey: "no-evidence",
    });
    expect(result.status).toBe("insufficient_evidence");
    const run = await runRow(c, result.runId);
    expect(run.status).toBe("failed");
    expect(run.error_code).toBe("INSUFFICIENT_EVIDENCE");
    const jobs = await c.pool.query("SELECT id FROM jobs");
    expect(jobs.rowCount).toBe(0);
  }));

it("未经批准的模板只生成待审题目，不自动发布", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const { skill } = await seedSkillWithKnowledge(c, f.admin.userId);
    await seedTemplate(c, f.admin.userId, {
      family: "rational_arithmetic",
      skillId: skill.id,
      params: { op: "+", a: 1, b: 4, c: 1, d: 4 },
      status: "pending_review",
    });
    const service = new QuestionGenerationService(c, new JobQueue(c));
    const { runId } = await service.enqueue(f.scope, {
      skillId: skill.id,
      templateCode: "rational_arithmetic",
      goal: "repair",
      requestKey: "unapproved",
    });
    const result = await service.generate(runId);
    expect(result.status).toBe("pending_review");
    const entry = await entryRow(c, result.entryId!);
    expect(entry.status).toBe("pending_review");
    expect(entry.visibility).toBe("owner_only");
    expect(entry.source_type).toBe("template");
  }));

it("已批准且求解一致的模板题目直接发布", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const { skill } = await seedSkillWithKnowledge(c, f.admin.userId);
    await seedTemplate(c, f.admin.userId, {
      family: "rational_arithmetic",
      skillId: skill.id,
      params: { op: "+", a: 1, b: 4, c: 1, d: 4 },
      status: "approved",
    });
    const service = new QuestionGenerationService(c, new JobQueue(c));
    const { runId } = await service.enqueue(f.scope, {
      skillId: skill.id,
      templateCode: "rational_arithmetic",
      goal: "repair",
      requestKey: "approved",
    });
    const result = await service.generate(runId);
    expect(result.status).toBe("verified");
    const entry = await entryRow(c, result.entryId!);
    expect(entry.status).toBe("published");
    expect(entry.owner_id).toBe(f.scope.studentId);
    const run = await runRow(c, runId);
    expect(Array.isArray(run.knowledge_evidence)).toBe(true);
    expect((run.knowledge_evidence as unknown[]).length).toBe(1);
  }));

it("纯模型生成即使独立求解一致也待人工审核", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const { skill } = await seedSkillWithKnowledge(c, f.admin.userId);
    const consistent = gateway(async (request) =>
      request.context.systemPrompt?.includes("独立解题")
        ? reply({
            referenceAnswer: "1/2",
            answerType: "number",
            requiresWorking: false,
            reason: "独立计算一致",
          })
        : reply({
            stem: "1/4 加 1/4 等于多少？",
            referenceAnswer: "1/2",
            answerType: "number",
            requiresWorking: false,
          }),
    );
    const service = new QuestionGenerationService(c, new JobQueue(c), consistent);
    const { runId } = await service.enqueue(f.scope, {
      skillId: skill.id,
      templateCode: "llm",
      goal: "transfer",
      requestKey: "llm-review",
    });
    const result = await service.generate(runId);
    expect(result.status).toBe("pending_review");
    const entry = await entryRow(c, result.entryId!);
    expect(entry.status).toBe("pending_review");
    expect(entry.source_type).toBe("generated");
  }));

it("相同请求键按学生隔离，生成的题目互不可见", async () =>
  withTestDb(async (c) => {
    const f = await catalogFixture(c);
    const { skill } = await seedSkillWithKnowledge(c, f.admin.userId);
    await seedTemplate(c, f.admin.userId, {
      family: "rational_arithmetic",
      skillId: skill.id,
      params: { op: "+", a: 1, b: 4, c: 1, d: 4 },
      status: "approved",
    });
    const other = await secondStudent(f);
    const otherScope = {
      actor: { userId: other.userId, role: "student" as const },
      studentId: other.studentId,
    };
    const service = new QuestionGenerationService(c, new JobQueue(c));
    const first = await service.enqueue(f.scope, {
      skillId: skill.id,
      templateCode: "rational_arithmetic",
      goal: "repair",
      requestKey: "same-key",
    });
    const second = await service.enqueue(otherScope, {
      skillId: skill.id,
      templateCode: "rational_arithmetic",
      goal: "repair",
      requestKey: "same-key",
    });
    expect(first.runId).not.toBe(second.runId);
    const firstResult = await service.generate(first.runId);
    const secondResult = await service.generate(second.runId);
    expect(firstResult.entryId).not.toBe(secondResult.entryId);
    expect((await entryRow(c, firstResult.entryId!)).owner_id).toBe(
      f.scope.studentId,
    );
    expect((await entryRow(c, secondResult.entryId!)).owner_id).toBe(
      other.studentId,
    );

    const visibleToFirst = await searchEligibleQuestions(c, f.scope, {
      skillId: skill.id,
      goal: "repair",
    });
    expect(visibleToFirst.map((item) => item.entryId)).toEqual([
      firstResult.entryId,
    ]);
    const visibleToSecond = await searchEligibleQuestions(c, otherScope, {
      skillId: skill.id,
      goal: "repair",
    });
    expect(visibleToSecond.map((item) => item.entryId)).toEqual([
      secondResult.entryId,
    ]);
  }));
