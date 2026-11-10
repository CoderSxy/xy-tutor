import { expect, it } from "vitest";
import { addDays } from "../../apps/server/src/modules/student-insights/metrics.js";
import { InsightReportGenerator } from "../../apps/server/src/modules/student-insights/report-generator.js";
import { InsightReportService } from "../../apps/server/src/modules/student-insights/reports.js";
import { JobQueue, type Job } from "../../apps/server/src/jobs/queue.js";
import type {
  ModelRequest,
  ModelResult,
} from "../../packages/contracts/src/agent.js";
import type { ModelGateway } from "../../apps/server/src/agent/provider.js";
import type { AdminInsightScope } from "../../packages/contracts/src/student-insights.js";
import { withTestDb } from "../helpers/database.js";
import {
  seedInsightFacts,
  studentInsightsFixture,
  type StudentInsightsFixture,
} from "../helpers/student-insights.js";

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

function reportContent(key: string): ModelResult {
  return {
    text: JSON.stringify({
      summary: "近期完成了几次练习。",
      strengths: [{ text: "基础题稳定。", evidenceKeys: [key] }],
      difficulties: [{ text: "综合题漏步。", evidenceKeys: [key] }],
      habits: [{ text: "练习间隔较短。", evidenceKeys: [key] }],
      recommendations: [
        { text: "先复盘错题。", basisEvidenceKeys: [key], priority: "high" },
      ],
      limitations: ["样本较少。"],
    }),
    toolCalls: [],
  };
}

function evidenceKey(request: ModelRequest): string {
  const payload = JSON.parse(
    request.context.messages[0]!.content as string,
  ) as { evidence: { key: string }[] };
  return payload.evidence[0]!.key;
}

function okGateway(): ModelGateway {
  return gateway(async (request) => reportContent(evidenceKey(request)));
}

type Setup = {
  fixture: StudentInsightsFixture;
  scope: AdminInsightScope;
  reports: InsightReportService;
  queue: JobQueue;
  reportId: string;
  job: Job;
};

async function prepare(fixture: StudentInsightsFixture): Promise<Setup> {
  const seed = await seedInsightFacts(fixture);
  const reports = new InsightReportService(fixture.db, true);
  const scope = { actor: fixture.admin, studentId: fixture.studentA.studentId };
  const created = await reports.create(scope, {
    from: addDays(seed.today, -10),
    to: seed.today,
  });
  const queue = new JobQueue(fixture.db);
  const job = await queue.claim("worker-a", new Date());
  expect(job).toMatchObject({ kind: "student.insight" });
  return { fixture, scope, reports, queue, reportId: created.reportId, job: job! };
}

async function reportRow(fixture: StudentInsightsFixture, id: string) {
  return (
    await fixture.db.pool.query<{
      status: string;
      generation: number;
      error_code: string | null;
      content: unknown;
      model: string | null;
      completed_at: Date | null;
    }>(
      `SELECT status, generation, error_code, content, model, completed_at
       FROM student_insight_reports WHERE id=$1`,
      [id],
    )
  ).rows[0]!;
}

async function jobRow(fixture: StudentInsightsFixture, id: string) {
  return (
    await fixture.db.pool.query<{
      status: string;
      attempts: number;
      error_code: string | null;
      lease_token: string | null;
    }>(
      "SELECT status, attempts, error_code, lease_token FROM jobs WHERE id=$1",
      [id],
    )
  ).rows[0]!;
}

async function expireLease(fixture: StudentInsightsFixture, id: string) {
  await fixture.db.pool.query(
    "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [id],
  );
}

function generatorFor(
  setup: Setup,
  gw: ModelGateway,
  timeoutMs?: number,
) {
  return new InsightReportGenerator(setup.fixture.db, gw, {
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

it("保存合法响应并把报告与任务一起标记完成", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const gw = okGateway();
    const setup = await prepare(fixture);
    let calls = 0;
    const spy = gateway(async (request, signal) => {
      calls += 1;
      return gw.complete(request, signal);
    });
    await generatorFor(setup, spy).generate(setup.job, new AbortController().signal);
    const report = await reportRow(fixture, setup.reportId);
    expect(report).toMatchObject({
      status: "completed",
      model: "test-model",
      error_code: null,
    });
    expect(report.completed_at).toBeInstanceOf(Date);
    expect(report.content).toMatchObject({ summary: "近期完成了几次练习。" });
    expect(await jobRow(fixture, setup.job.id)).toMatchObject({
      status: "completed",
      lease_token: null,
    });
    expect(calls).toBe(1);
  }));

it("非法 JSON 记为 INVALID_OUTPUT 并保留可重试状态", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const gw = gateway(async () => ({ text: "not json", toolCalls: [] }));
    const setup = await prepare(fixture);
    await expect(
      generatorFor(setup, gw).generate(setup.job, new AbortController().signal),
    ).rejects.toThrow("INVALID_OUTPUT");
    expect(await reportRow(fixture, setup.reportId)).toMatchObject({
      status: "queued",
      error_code: "INVALID_OUTPUT",
    });
    expect(await jobRow(fixture, setup.job.id)).toMatchObject({
      status: "queued",
      attempts: 1,
      error_code: "INVALID_OUTPUT",
    });
  }));

it("超时中止模型调用并记为 TIMEOUT", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const gw = gateway(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const setup = await prepare(fixture);
    await expect(
      generatorFor(setup, gw, 20).generate(
        setup.job,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(await reportRow(fixture, setup.reportId)).toMatchObject({
      status: "queued",
      error_code: "TIMEOUT",
    });
  }));

it("三次自动重试后报告与任务标记失败", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const gw = gateway(async () => ({ text: "not json", toolCalls: [] }));
    const setup = await prepare(fixture);
    const generator = generatorFor(setup, gw);
    let job = setup.job;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(
        generator.generate(job, new AbortController().signal),
      ).rejects.toThrow();
      if (attempt < 3)
        job = (await setup.queue.claim(
          "worker-a",
          new Date(Date.now() + attempt * 11_000),
        ))!;
    }
    const report = await reportRow(fixture, setup.reportId);
    expect(report).toMatchObject({
      status: "failed",
      error_code: "INVALID_OUTPUT",
    });
    expect(report.completed_at).toBeInstanceOf(Date);
    expect(await jobRow(fixture, setup.job.id)).toMatchObject({
      status: "failed",
      attempts: 3,
      error_code: "INVALID_OUTPUT",
    });
  }));

it("人工重试提升 generation 且旧 generation 不改写新报告", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const gw = gateway(async () => ({ text: "not json", toolCalls: [] }));
    const setup = await prepare(fixture);
    const generator = generatorFor(setup, gw);
    let job = setup.job;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(
        generator.generate(job, new AbortController().signal),
      ).rejects.toThrow();
      if (attempt < 3)
        job = (await setup.queue.claim(
          "worker-a",
          new Date(Date.now() + attempt * 11_000),
        ))!;
    }
    const retried = await setup.reports.retry(setup.scope, setup.reportId);
    expect(retried).toMatchObject({ status: "queued", generation: 2 });
    await fixture.db.pool.query(
      `UPDATE jobs SET status='running', attempts=3, lease_expires_at=now()-interval '1 second'
       WHERE id=$1`,
      [setup.job.id],
    );
    await setup.queue.claim("worker-b", new Date());
    expect(await reportRow(fixture, setup.reportId)).toMatchObject({
      status: "queued",
      generation: 2,
      error_code: null,
    });
  }));

it("租约被抢占后旧 worker 不会调用模型或写入结果", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    let release!: (value: ModelResult) => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<ModelResult>((resolve) => {
      release = resolve;
    });
    const gw = gateway(async (request) => {
      started();
      const result = await pending;
      return {
        text: reportContent(evidenceKey(request)).text,
        toolCalls: result.toolCalls,
      };
    });
    const setup = await prepare(fixture);
    let calls = 0;
    const counting = gateway(async (request, signal) => {
      calls += 1;
      return gw.complete(request, signal);
    });
    const first = generatorFor(setup, counting).generate(
      setup.job,
      new AbortController().signal,
    );
    await startedPromise;
    await expireLease(fixture, setup.job.id);
    const second = (await setup.queue.claim("worker-b", new Date()))!;
    expect(second.id).toBe(setup.job.id);
    expect(second.leaseToken).not.toBe(setup.job.leaseToken);
    release({ text: "", toolCalls: [] });
    await expect(first).rejects.toThrow("LEASE_LOST");
    expect(await reportRow(fixture, setup.reportId)).toMatchObject({
      status: "running",
      error_code: null,
    });
    expect(await jobRow(fixture, setup.job.id)).toMatchObject({
      status: "running",
      lease_token: second.leaseToken,
    });
    expect(calls).toBe(1);
  }));

it("最终租约过期由队列原子修复报告为失败", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const setup = await prepare(fixture);
    await expireLease(fixture, setup.job.id);
    await setup.queue.claim("worker-b", new Date(Date.now() + 1_000));
    await expireLease(fixture, setup.job.id);
    await setup.queue.claim("worker-c", new Date(Date.now() + 2_000));
    await expireLease(fixture, setup.job.id);
    await setup.queue.claim("worker-d", new Date(Date.now() + 3_000));
    expect(await reportRow(fixture, setup.reportId)).toMatchObject({
      status: "failed",
      error_code: "INTERRUPTED",
    });
    const report = await reportRow(fixture, setup.reportId);
    expect(report.completed_at).toBeInstanceOf(Date);
    expect(await jobRow(fixture, setup.job.id)).toMatchObject({
      status: "failed",
      error_code: "INTERRUPTED",
      lease_token: null,
    });
  }));

it("提交完成后重启不会重复调用模型也不降级完成状态", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    let calls = 0;
    const gw = gateway(async (request) => {
      calls += 1;
      return reportContent(evidenceKey(request));
    });
    const setup = await prepare(fixture);
    await generatorFor(setup, gw).generate(
      setup.job,
      new AbortController().signal,
    );
    expect(await setup.queue.finish(setup.job.id, setup.job.leaseToken, {})).toBe(
      false,
    );
    await generatorFor(setup, gw).generate(
      setup.job,
      new AbortController().signal,
    );
    expect(calls).toBe(1);
    expect(await reportRow(fixture, setup.reportId)).toMatchObject({
      status: "completed",
      error_code: null,
    });
  }));
