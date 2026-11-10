import { expect, it } from "vitest";
import type pg from "pg";
import type { Database } from "../../packages/db/src/client.js";
import { withTestDb } from "../helpers/database.js";
import {
  seedInsightFacts,
  studentInsightsFixture,
} from "../helpers/student-insights.js";
import {
  initializeInsightCollection,
  InsightActivityService,
} from "../../apps/server/src/modules/student-insights/activity.js";
import { InsightReportService } from "../../apps/server/src/modules/student-insights/reports.js";
import { backfillStudentInsights } from "../../apps/server/src/modules/student-insights/backfill.js";
import {
  addDays,
  dayStartUtc,
} from "../../apps/server/src/modules/student-insights/metrics.js";

it("filters learning activity by textbook", () =>
  withTestDb(async (db) => {
    const f = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(f);
    await db.pool.query("DELETE FROM student_learning_events");
    await db.pool.query(
      `INSERT INTO student_learning_events(student_id,event_type,source_type,source_id,task_id,revision_id,occurred_at)
    VALUES($1,'answer_submitted','attempt',$2,$3,$4,now())`,
      [
        f.studentA.studentId,
        seed.attemptIds.firstA,
        seed.taskA,
        seed.revisionA,
      ],
    );
    const activity = new InsightActivityService(db);
    const scope = { actor: f.admin, studentId: f.studentA.studentId };
    const filter = { from: seed.today, to: seed.today };
    expect(
      (await activity.get(scope, { ...filter, revisionId: seed.revisionA }))
        .activeDays,
    ).toBe(1);
    expect(
      (await activity.get(scope, { ...filter, revisionId: seed.revisionB }))
        .activeDays,
    ).toBe(0);
  }));

it("backfills the partial switch day without crossing the collection boundary", () =>
  withTestDb(async (db) => {
    const f = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(f);
    const switchAt = new Date(dayStartUtc(seed.today).getTime() + 12 * 3600000);
    await initializeInsightCollection(db, switchAt);
    await db.pool.query("DELETE FROM student_learning_events");
    await db.pool.query("UPDATE attempts SET created_at=$2 WHERE id=$1", [
      seed.attemptIds.firstA,
      new Date(switchAt.getTime() - 1000),
    ]);
    await db.pool.query("UPDATE attempts SET created_at=$2 WHERE id=$1", [
      seed.attemptIds.redoA,
      switchAt,
    ]);
    await backfillStudentInsights(db, {
      from: seed.today,
      to: seed.today,
      batchSize: 500,
    });
    const events = (
      await db.pool.query(
        "SELECT source_id FROM student_learning_events WHERE source_type='attempt'",
      )
    ).rows;
    expect(events.map((row) => row.source_id)).toContain(
      seed.attemptIds.firstA,
    );
    expect(events.map((row) => row.source_id)).not.toContain(
      seed.attemptIds.redoA,
    );
  }));

it("rejects retry while a different report for the same student is active", () =>
  withTestDb(async (db) => {
    const f = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(f);
    const reports = new InsightReportService(db, true);
    const scope = { actor: f.admin, studentId: f.studentA.studentId };
    const first = await reports.create(scope, {
      from: addDays(seed.today, -10),
      to: seed.today,
    });
    await db.pool.query(
      "UPDATE student_insight_reports SET status='failed' WHERE id=$1",
      [first.reportId],
    );
    const active = await reports.create(scope, {
      from: addDays(seed.today, -12),
      to: seed.today,
    });
    await expect(reports.retry(scope, first.reportId)).rejects.toMatchObject({
      status: 409,
      details: { reportId: active.reportId },
    });
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM student_insight_reports WHERE status IN ('queued','running')",
        )
      ).rows[0].n,
    ).toBe(1);
  }));

it("freezes report totals and evidence across a concurrent answer edit", () =>
  withTestDb(async (db) => {
    const f = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(f);
    let edited = false;
    // Interleave a real independent commit between overview and evidence reads.
    const wrapped = {
      ...db,
      pool: {
        connect: async () => {
          const client = await db.pool.connect();
          return {
            query: async (sql: string, params?: unknown[]) => {
              if (!edited && sql.includes("left(a.answer, 1000)")) {
                edited = true;
                await db.pool.query(
                  "UPDATE attempts SET answer='CONCURRENT_EDIT' WHERE student_id=$1",
                  [f.studentA.studentId],
                );
              }
              return client.query(sql, params as never);
            },
            release: (error?: boolean) => client.release(error),
          } as unknown as pg.PoolClient;
        },
      },
    } as unknown as Database;
    const report = await new InsightReportService(wrapped, true).create(
      { actor: f.admin, studentId: f.studentA.studentId },
      { from: addDays(seed.today, -10), to: seed.today },
    );
    expect(edited).toBe(true);
    const row = (
      await db.pool.query(
        "SELECT evidence_catalog FROM student_insight_reports WHERE id=$1",
        [report.reportId],
      )
    ).rows[0];
    expect(
      row.evidence_catalog.some((item: { summary: string }) =>
        item.summary.includes("CONCURRENT_EDIT"),
      ),
    ).toBe(false);
  }));
