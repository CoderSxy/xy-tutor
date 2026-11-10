import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import {
  seedInsightFacts,
  studentInsightsFixture,
  type InsightFactsSeed,
  type StudentInsightsFixture,
} from "../helpers/student-insights.js";
import { buildApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import {
  addDays,
  dayStartUtc,
  inclusiveDays,
} from "../../apps/server/src/modules/student-insights/metrics.js";
import { InsightQueryService } from "../../apps/server/src/modules/student-insights/queries.js";
import { adminInsightCookie } from "../helpers/student-insights.js";

const at = (today: string, offset: number, hour: number) =>
  new Date(dayStartUtc(addDays(today, offset)).getTime() + hour * 3_600_000);

async function seedLearningEvents(
  fixture: StudentInsightsFixture,
  seed: InsightFactsSeed,
): Promise<void> {
  const rows: [string, string, number, number][] = [
    [seed.attemptIds.firstA, seed.revisionA, -5, 10],
    [seed.attemptIds.redoA, seed.revisionA, -4, 10],
    [seed.attemptIds.lifetimeFirstOutside, seed.revisionA, -60, 10],
    [seed.attemptIds.redoB, seed.revisionA, -3, 10],
    [seed.attemptIds.revisionB, seed.revisionB, -4, 11],
    [seed.attemptIds.pending, seed.revisionA, -2, 10],
  ];
  for (const [attemptId, revisionId, dayOffset, hour] of rows)
    await fixture.db.pool.query(
      `INSERT INTO student_learning_events
         (student_id,actor_id,event_type,source_type,source_id,task_id,revision_id,occurred_at)
       VALUES($1,$2,'answer_submitted','attempt',$3,$4,$5,$6)`,
      [
        fixture.studentA.studentId,
        fixture.studentA.actor.userId,
        attemptId,
        seed.taskA,
        revisionId,
        at(seed.today, dayOffset, hour),
      ],
    );
}

async function list(
  fixture: StudentInsightsFixture,
  now: Date,
  input: Parameters<InsightQueryService["list"]>[1],
) {
  const service = new InsightQueryService(fixture.db, () => now);
  return service.list(fixture.admin, input);
}

async function addPendingMistakes(
  fixture: StudentInsightsFixture,
  seed: InsightFactsSeed,
  studentId: string,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const questionId = (
      await fixture.db.pool.query<{ id: string }>(
        `INSERT INTO questions(student_id,revision_id,source_type)
         VALUES($1,$2,'teacher') RETURNING id`,
        [studentId, seed.revisionA],
      )
    ).rows[0]!.id;
    await fixture.db.pool.query(
      `INSERT INTO question_versions(question_id,version_no,stem,knowledge_point)
       VALUES($1,1,'题','分数')`,
      [questionId],
    );
    await fixture.db.pool.query(
      `INSERT INTO student_mistakes(student_id,question_id,status,created_at)
       VALUES($1,$2,'pending_correction',$3)`,
      [studentId, questionId, at(seed.today, -10, 9)],
    );
  }
}

it("lists every student with zero-safe rates and filled summary", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const now = new Date();
    const seed = await seedInsightFacts(fixture, now);
    await seedLearningEvents(fixture, seed);

    const result = await list(fixture, now, {
      limit: 20,
      offset: 0,
      sort: "last_learning_at",
      attention: "any",
    });
    expect(result.total).toBe(3);
    expect(result.summary).toEqual({
      students: 3,
      activeStudents: 1,
      attempts: 5,
      newMistakes: 2,
    });

    const empty = result.items.find(
      (row) => row.studentId === fixture.emptyStudentId,
    );
    expect(empty).toBeDefined();
    expect(empty?.firstAttemptAccuracy).toEqual({
      numerator: 0,
      denominator: 0,
      value: null,
    });
    expect(empty?.taskCompletion.value).toBeNull();
    expect(empty?.lastLearningAt).toBeNull();
    expect(empty?.attentionReasons).toEqual([]);

    const a = result.items.find((row) => row.studentId === fixture.studentA.studentId);
    expect(a?.attempts).toBe(5);
    expect(a?.questions).toBe(3);
    expect(a?.firstAttemptAccuracy).toEqual({
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
    expect(a?.activeDays).toBe(4);
  }));

it("merges multiple accounts of the same student into one row", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const now = new Date();
    await seedInsightFacts(fixture, now);

    const result = await list(fixture, now, {
      limit: 20,
      offset: 0,
      sort: "last_learning_at",
      attention: "any",
    });
    const rows = result.items.filter(
      (row) => row.studentId === fixture.studentA.studentId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.studentLogins).toEqual([
      fixture.studentA.login,
      fixture.studentB.login,
    ]);
  }));

it("keeps students without data visible under a revision filter", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const now = new Date();
    const seed = await seedInsightFacts(fixture, now);
    await seedLearningEvents(fixture, seed);

    const result = await list(fixture, now, {
      limit: 20,
      offset: 0,
      sort: "last_learning_at",
      attention: "any",
      revisionId: seed.revisionB,
    });
    expect(result.total).toBe(3);
    const a = result.items.find((row) => row.studentId === fixture.studentA.studentId);
    expect(a?.attempts).toBe(1);
    expect(a?.questions).toBe(1);
    expect(a?.firstAttemptAccuracy).toEqual({
      numerator: 0,
      denominator: 1,
      value: 0,
    });
    const empty = result.items.find(
      (row) => row.studentId === fixture.emptyStudentId,
    );
    expect(empty?.attempts).toBe(0);
  }));

it("flags inactivity only from the seventh idle day onward", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const now = new Date();
    await seedInsightFacts(fixture, now);

    const idle = await list(fixture, now, {
      limit: 20,
      offset: 0,
      sort: "last_learning_at",
      attention: "inactive_7d",
    });
    expect(idle.total).toBe(0);

    await db.pool.query(
      "UPDATE student_profiles SET created_at = $2 WHERE id = $1",
      [fixture.studentB.studentId, new Date(now.getTime() - 7 * 86_400_000)],
    );
    const flagged = await list(fixture, now, {
      limit: 20,
      offset: 0,
      sort: "last_learning_at",
      attention: "inactive_7d",
    });
    expect(flagged.total).toBe(1);
    expect(flagged.items[0]!.studentId).toBe(fixture.studentB.studentId);
    expect(flagged.items[0]!.attentionReasons[0]!).toMatchObject({
      type: "inactive_7d",
      value: 7,
    });
  }));

it("flags pending corrections at exactly ten", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const now = new Date();
    const seed = await seedInsightFacts(fixture, now);
    await addPendingMistakes(fixture, seed, fixture.studentB.studentId, 9);

    const nine = await list(fixture, now, {
      limit: 20,
      offset: 0,
      sort: "last_learning_at",
      attention: "pending_corrections_10",
    });
    expect(nine.total).toBe(0);

    await addPendingMistakes(fixture, seed, fixture.studentB.studentId, 1);
    const ten = await list(fixture, now, {
      limit: 20,
      offset: 0,
      sort: "last_learning_at",
      attention: "pending_corrections_10",
    });
    expect(ten.total).toBe(1);
    expect(ten.items[0]!.pendingCorrections).toBe(10);
    expect(ten.items[0]!.attentionReasons[0]!).toMatchObject({
      type: "pending_corrections_10",
      value: 10,
    });
  }));

it("paginates deterministically over a stable total", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const now = new Date();
    const seed = await seedInsightFacts(fixture, now);
    await seedLearningEvents(fixture, seed);

    const seen: string[] = [];
    for (const offset of [0, 1, 2]) {
      const page = await list(fixture, now, {
        limit: 1,
        offset,
        sort: "active_days",
        attention: "any",
      });
      expect(page.total).toBe(3);
      expect(page.items).toHaveLength(1);
      seen.push(page.items[0]!.studentId);
    }
    expect(new Set(seen).size).toBe(3);
    expect(seen[0]).toBe(fixture.studentA.studentId);
  }));

it("treats search input as plain text", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const now = new Date();
    await seedInsightFacts(fixture, now);

    const injected = await list(fixture, now, {
      limit: 20,
      offset: 0,
      sort: "last_learning_at",
      attention: "any",
      q: "空' OR 1=1 --",
    });
    expect(injected.total).toBe(0);

    const matched = await list(fixture, now, {
      limit: 20,
      offset: 0,
      sort: "last_learning_at",
      attention: "any",
      q: "空档案",
    });
    expect(matched.total).toBe(1);
    expect(matched.items[0]!.studentId).toBe(fixture.emptyStudentId);
    const profiles = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM student_profiles",
    );
    expect(profiles.rows[0]!.n).toBe(3);
  }));

it("builds a complete overview with daily points and material coverage", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const now = new Date();
    const seed = await seedInsightFacts(fixture, now);
    await seedLearningEvents(fixture, seed);

    const service = new InsightQueryService(fixture.db, () => now);
    const from = addDays(seed.today, -29);
    const result = await service.overview(
      { actor: fixture.admin, studentId: fixture.studentA.studentId },
      { from, to: seed.today },
    );
    const overview = result.overview;
    expect(overview.displayName).toBe(fixture.studentA.login);
    expect(overview.counts.attempts).toBe(5);
    expect(overview.counts.questions).toBe(3);
    expect(overview.counts.newMistakes).toBe(2);
    expect(overview.counts.tasks).toBe(1);
    expect(overview.counts.completedTasks).toBe(0);
    expect(overview.counts.activeDays).toBe(4);
    expect(overview.counts.currentStreak).toBe(0);
    expect(overview.counts.longestStreak).toBe(4);
    expect(overview.counts.firstAttemptPending).toBe(0);
    expect(overview.counts.mistakes).toEqual({
      pending_correction: 2,
      correcting: 0,
      corrected_pending_practice: 0,
      consolidated_pending_review: 0,
      mastered: 0,
    });
    expect(overview.firstAttemptAccuracy).toEqual({
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
    expect(overview.taskCompletion).toEqual({
      numerator: 0,
      denominator: 1,
      value: 0,
    });
    expect(overview.lastLearningAt).toBe(
      at(seed.today, -2, 10).toISOString(),
    );

    expect(overview.daily.map((point) => point.date)).toEqual(
      inclusiveDays(from, seed.today),
    );
    expect(overview.daily.reduce((sum, point) => sum + point.attempts, 0)).toBe(5);
    expect(overview.daily.filter((point) => point.attempts > 0)).toHaveLength(4);

    expect(overview.knowledge).toEqual([
      {
        knowledgePoint: "分数",
        attempts: 5,
        verified: 4,
        correct: 1,
        hintDependency: { none: 5 },
      },
    ]);
    expect(overview.materials).toEqual([
      {
        materialId: seed.material,
        name: "作业.jpg",
        type: "homework",
        status: "ready",
        totalQuestions: 1,
        answeredQuestions: 1,
        verifiedQuestions: 1,
      },
    ]);
    expect(result.meta.coverage.learning).toBe("partial");
    expect(result.meta.coverage.visitsStartedAt).toBeNull();
  }));

it("serves overviews through the admin route", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const now = new Date();
    const seed = await seedInsightFacts(fixture, now);

    const app = buildApp({
      database: fixture.db,
      config: loadConfig({ NODE_ENV: "test" }),
    });
    try {
      const response = await app.inject({
        method: "GET",
        url:
          `/api/admin/student-insights/students/${fixture.studentA.studentId}/overview` +
          `?from=${addDays(seed.today, -29)}&to=${seed.today}`,
        headers: adminInsightCookie(fixture),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.overview.studentId).toBe(fixture.studentA.studentId);
      expect(body.meta.metricVersion).toBe("student-insights-v1");
      expect(body.overview.daily).toHaveLength(30);

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/admin/student-insights/students?limit=2&sort=active_days",
        headers: adminInsightCookie(fixture),
      });
      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.json().items).toHaveLength(2);
      expect(listResponse.json().total).toBe(3);
    } finally {
      await app.close();
    }
  }));
