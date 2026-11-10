import { expect, it } from "vitest";
import { buildApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import type { ModelGateway } from "../../apps/server/src/agent/provider.js";
import {
  InsightReportService,
} from "../../apps/server/src/modules/student-insights/reports.js";
import { addDays } from "../../apps/server/src/modules/student-insights/metrics.js";
import type {
  AdminInsightScope,
  ReportCreateResult,
} from "../../packages/contracts/src/student-insights.js";
import { withTestDb } from "../helpers/database.js";
import {
  adminInsightCookie,
  seedInsightFacts,
  studentInsightsFixture,
  type InsightFactsSeed,
  type StudentInsightsFixture,
} from "../helpers/student-insights.js";

function service(fixture: StudentInsightsFixture, configured = true) {
  return new InsightReportService(fixture.db, configured);
}

function scopeOf(fixture: StudentInsightsFixture): AdminInsightScope {
  return { actor: fixture.admin, studentId: fixture.studentA.studentId };
}

function rangeOf(seed: InsightFactsSeed, days = 10) {
  return { from: addDays(seed.today, -days), to: seed.today };
}

function app(fixture: StudentInsightsFixture, configured = true) {
  return buildApp({
    database: fixture.db,
    config: loadConfig({ NODE_ENV: "test" }),
    gateway: configured ? ({} as unknown as ModelGateway) : undefined,
  });
}

async function reportCount(fixture: StudentInsightsFixture): Promise<number> {
  return (
    await fixture.db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM student_insight_reports",
    )
  ).rows[0]!.n;
}

async function jobCount(fixture: StudentInsightsFixture): Promise<number> {
  return (
    await fixture.db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM jobs",
    )
  ).rows[0]!.n;
}

it("creates one report and one job for concurrent identical requests", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const reports = service(fixture);
    const filter = rangeOf(seed);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reports.create(scopeOf(fixture), filter)),
    );
    expect(new Set(results.map((item) => item.reportId)).size).toBe(1);
    expect(results.filter((item) => !item.reused)).toHaveLength(1);
    expect(await reportCount(fixture)).toBe(1);
    expect(await jobCount(fixture)).toBe(1);
  }));

it("treats an empty revision filter as the same snapshot key", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const reports = service(fixture);
    const first = await reports.create(scopeOf(fixture), rangeOf(seed));
    const second = await reports.create(scopeOf(fixture), rangeOf(seed));
    expect(first.reused).toBe(false);
    expect(second).toEqual({
      reportId: first.reportId,
      status: "queued",
      reused: true,
    });
    expect(await reportCount(fixture)).toBe(1);
  }));

it("reuses a failed snapshot without enqueueing or spending quota", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const reports = service(fixture);
    const filter = rangeOf(seed);
    const first = await reports.create(scopeOf(fixture), filter);
    await db.pool.query(
      "UPDATE student_insight_reports SET status='failed', error_code='PROVIDER' WHERE id=$1",
      [first.reportId],
    );
    const reused = await reports.create(scopeOf(fixture), filter);
    expect(reused).toEqual({
      reportId: first.reportId,
      status: "failed",
      reused: true,
    });
    expect(await jobCount(fixture)).toBe(1);
    // 创建 + 一次重试仍在额度内，说明复用没有占额度。
    await expect(reports.retry(scopeOf(fixture), first.reportId)).resolves.toMatchObject(
      { status: "queued", generation: 2 },
    );
  }));

it("allows three generations per minute and rejects the fourth", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const reports = service(fixture);
    const scope = scopeOf(fixture);
    const first = await reports.create(scope, rangeOf(seed));
    for (let generation = 1; generation <= 2; generation += 1) {
      await db.pool.query(
        "UPDATE student_insight_reports SET status='failed' WHERE id=$1",
        [first.reportId],
      );
      await reports.retry(scope, first.reportId);
    }
    await db.pool.query(
      "UPDATE student_insight_reports SET status='failed' WHERE id=$1",
      [first.reportId],
    );
    await expect(reports.retry(scope, first.reportId)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    });
  }));

it("rejects reports for students without learning evidence", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    await expect(
      service(fixture).create(
        { actor: fixture.admin, studentId: fixture.emptyStudentId },
        rangeOf(seed),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 422 });
  }));

it("refuses to start reports without a configured model", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    await expect(
      service(fixture, false).create(scopeOf(fixture), rangeOf(seed)),
    ).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      status: 503,
    });
  }));

it("returns 409 with the active report for a concurrent different range", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const reports = service(fixture);
    const scope = scopeOf(fixture);
    const results = await Promise.allSettled([
      reports.create(scope, rangeOf(seed)),
      reports.create(scope, rangeOf(seed, 12)),
    ]);
    const fulfilled = results.filter(
      (item): item is PromiseFulfilledResult<ReportCreateResult> =>
        item.status === "fulfilled",
    );
    const rejected = results.filter(
      (item): item is PromiseRejectedResult => item.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({
      code: "CONFLICT",
      status: 409,
      details: { reportId: fulfilled[0]!.value.reportId },
    });
  }));

it("serves history, report detail and evidence links over the admin API", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const server = app(fixture);
    const url = `/api/admin/student-insights/students/${fixture.studentA.studentId}`;
    const created = await server.inject({
      method: "POST",
      url: `${url}/reports`,
      headers: adminInsightCookie(fixture),
      payload: rangeOf(seed),
    });
    expect(created.statusCode).toBe(202);
    const createdBody = created.json() as {
      reportId: string;
      status: string;
      reused: boolean;
    };
    expect(createdBody).toMatchObject({ status: "queued", reused: false });

    const reused = await server.inject({
      method: "POST",
      url: `${url}/reports`,
      headers: adminInsightCookie(fixture),
      payload: rangeOf(seed),
    });
    expect(reused.statusCode).toBe(200);
    expect(reused.json()).toMatchObject({
      reportId: createdBody.reportId,
      reused: true,
    });

    const history = await server.inject({
      method: "GET",
      url: `${url}/reports?limit=10&offset=0`,
      headers: adminInsightCookie(fixture),
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({
      total: 1,
      items: [{ id: createdBody.reportId, evidenceCount: expect.any(Number) }],
    });

    const detail = await server.inject({
      method: "GET",
      url: `${url}/reports/${createdBody.reportId}`,
      headers: adminInsightCookie(fixture),
    });
    expect(detail.statusCode).toBe(200);
    const report = detail.json() as {
      status: string;
      evidence: { key: string; kind: string }[];
    };
    expect(report.status).toBe("queued");
    const attempt = report.evidence.find((item) => item.kind === "attempt");
    expect(attempt).toBeDefined();
    const resolved = await server.inject({
      method: "GET",
      url: `${url}/reports/${createdBody.reportId}/evidence/${encodeURIComponent(attempt!.key)}`,
      headers: adminInsightCookie(fixture),
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      href: expect.stringContaining("/records/"),
      detail: { key: attempt!.key },
    });

    const foreign = await server.inject({
      method: "GET",
      url: `/api/admin/student-insights/students/${fixture.studentB.studentId}/reports/${createdBody.reportId}`,
      headers: adminInsightCookie(fixture),
    });
    expect(foreign.statusCode).toBe(404);

    const retryActive = await server.inject({
      method: "POST",
      url: `${url}/reports/${createdBody.reportId}/retry`,
      headers: adminInsightCookie(fixture),
    });
    expect(retryActive.statusCode).toBe(409);
  }));

it("drops invalidated evidence and yields a new snapshot", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const reports = service(fixture);
    const scope = scopeOf(fixture);
    const filter = rangeOf(seed);
    const first = await reports.create(scope, filter);
    await db.pool.query(
      "UPDATE student_insight_reports SET status='completed' WHERE id=$1",
      [first.reportId],
    );
    const before = await reports.get(scope, first.reportId);
    const attempt = before.evidence.find((item) => item.kind === "attempt")!;
    const versionId = (
      await db.pool.query<{ id: string }>(
        "SELECT question_version_id AS id FROM attempts WHERE id=$1",
        [attempt.id],
      )
    ).rows[0]!.id;
    await db.pool.query(
      `INSERT INTO evidence_invalidations(student_id,evidence_version_id,reason)
       VALUES($1,$2,'题目被撤回')`,
      [fixture.studentA.studentId, versionId],
    );

    await expect(
      reports.resolveEvidence(scope, first.reportId, attempt.key),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    const after = await reports.get(scope, first.reportId);
    expect(after.evidence.some((item) => item.key === attempt.key)).toBe(false);

    const second = await reports.create(scope, filter);
    expect(second.reused).toBe(false);
    expect(second.reportId).not.toBe(first.reportId);
  }));

it("drops soft-deleted task evidence and yields a new snapshot", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const reports = service(fixture);
    const scope = scopeOf(fixture);
    const filter = rangeOf(seed);
    const first = await reports.create(scope, filter);
    await db.pool.query(
      "UPDATE student_insight_reports SET status='completed' WHERE id=$1",
      [first.reportId],
    );
    const before = await reports.get(scope, first.reportId);
    const attempt = before.evidence.find((item) => item.kind === "attempt")!;
    await db.pool.query(
      "UPDATE learning_tasks SET deleted_at = now() WHERE id = $1",
      [seed.taskA],
    );
    await expect(
      reports.resolveEvidence(scope, first.reportId, attempt.key),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    const second = await reports.create(scope, filter);
    expect(second.reused).toBe(false);
    expect(second.reportId).not.toBe(first.reportId);
  }));

it("keeps taskless attempts and chats out of the navigable evidence catalog", () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const studentId = fixture.studentA.studentId;
    const tasklessAttempt = (
      await db.pool.query<{ id: string }>(
        `INSERT INTO attempts(student_id,task_id,question_version_id,request_key,answer)
         VALUES($1,NULL,$2,gen_random_uuid()::text,'自由练习') RETURNING id`,
        [studentId, seed.questionVersionA],
      )
    ).rows[0]!.id;
    const conversationId = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO conversations(student_id,revision_id) VALUES($1,$2) RETURNING id",
        [studentId, seed.revisionA],
      )
    ).rows[0]!.id;
    const messageId = (
      await db.pool.query<{ id: string }>(
        "INSERT INTO messages(conversation_id,role) VALUES($1,'user') RETURNING id",
        [conversationId],
      )
    ).rows[0]!.id;
    const tasklessVersion = (
      await db.pool.query<{ id: string }>(
        `INSERT INTO message_versions(message_id,version_no,content)
         VALUES($1,1,'自由提问') RETURNING id`,
        [messageId],
      )
    ).rows[0]!.id;

    const reports = service(fixture);
    const created = await reports.create(scopeOf(fixture), rangeOf(seed));
    const catalog = (
      await db.pool.query<{ evidence: { key: string }[] }>(
        "SELECT evidence_catalog AS evidence FROM student_insight_reports WHERE id=$1",
        [created.reportId],
      )
    ).rows[0]!.evidence;
    const keys = catalog.map((item) => item.key);
    expect(keys).not.toContain(`attempt:${tasklessAttempt}`);
    expect(keys).not.toContain(`message_version:${tasklessVersion}`);
    expect(keys.some((key) => key.startsWith("attempt:"))).toBe(true);
  }));
