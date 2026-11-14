import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import type { Database } from "../../packages/db/src/client.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { LearningEvaluationService } from "../../apps/server/src/modules/student-insights/learning-evaluations.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function day(offset: number): string {
  return new Date(Date.now() + SHANGHAI_OFFSET_MS + offset * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function at(offsetDays: number): Date {
  return new Date(`${day(offsetDays)}T04:00:00.000Z`);
}

const WINDOW = () => ({ from: day(-6), to: day(0) });

type Context = {
  studentId: string;
  adminId: string;
  taskId: string;
  skillId: string;
};

async function scenario(db: Database) {
  const f = await catalogFixture(db);
  const revision = await f.publish("人教版", "分数");
  const task = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
    revisionId: revision.id,
    kind: "daily_practice",
  });
  const skillId = randomUUID();
  await db.pool.query(
    "INSERT INTO skills(id,code,name,created_by) VALUES($1,$2,'分数加法',$3)",
    [skillId, `skill-${randomUUID()}`, f.admin.userId],
  );
  const context: Context = {
    studentId: f.scope.studentId,
    adminId: f.admin.userId,
    taskId: task.id,
    skillId,
  };
  return { f, task, skillId, context };
}

type SeedOptions = {
  createdAt: Date;
  correct?: boolean;
  timing?: { quality: "reliable" | "partial" | "unusable" | "missing"; ms: number | null };
  exposure?: "none" | "guided" | "solution_exposed" | "unknown";
  bucket?: { difficulty: string; complexity: number; answerType?: string };
};

async function seedAttempt(
  db: Database,
  context: Context,
  options: SeedOptions,
): Promise<{ attemptId: string; questionVersionId: string }> {
  const questionId = randomUUID();
  const questionVersionId = randomUUID();
  const attemptId = randomUUID();
  await db.pool.query(
    "INSERT INTO questions(id,student_id,source_type) VALUES($1,$2,'material_question')",
    [questionId, context.studentId],
  );
  await db.pool.query(
    `INSERT INTO question_versions(
       id,question_id,version_no,stem,reference_answer,verification)
     VALUES($1,$2,1,'计算题','1','verified')`,
    [questionVersionId, questionId],
  );
  if (options.bucket) {
    await db.pool.query(
      `INSERT INTO question_references(
         question_version_id,answer,answer_type,requires_working,verification,evidence)
       VALUES($1,'1',$2,false,'verified','{}')`,
      [questionVersionId, options.bucket.answerType ?? "number"],
    );
  }
  await db.pool.query(
    `INSERT INTO attempts(
       id,student_id,task_id,question_version_id,request_key,answer,created_at)
     VALUES($1,$2,$3,$4,$5,'1',$6)`,
    [
      attemptId,
      context.studentId,
      context.taskId,
      questionVersionId,
      `attempt-${randomUUID()}`,
      options.createdAt,
    ],
  );
  await db.pool.query(
    `INSERT INTO assessments(
       attempt_id,correctness,verification,hint_dependency,method,
       verifier_version,evidence)
     VALUES($1,$2,'verified','none','exact','v1','{}')`,
    [attemptId, options.correct === false ? "incorrect" : "correct"],
  );
  if (options.exposure) {
    await db.pool.query(
      `INSERT INTO tutoring_episodes(
         student_id,task_id,question_version_id,request_key,state,exposure,created_at)
       VALUES($1,$2,$3,$4,'finished',$5,$6)`,
      [
        context.studentId,
        context.taskId,
        questionVersionId,
        `episode-${randomUUID()}`,
        options.exposure,
        options.createdAt,
      ],
    );
  }
  if (options.timing) {
    await db.pool.query(
      `INSERT INTO attempt_timing_snapshots(
         attempt_id,version,first_attempt_ms,quality,reason_codes)
       VALUES($1,1,$2,$3,'[]')`,
      [attemptId, options.timing.ms, options.timing.quality],
    );
  }
  if (options.bucket) {
    const entryId = randomUUID();
    await db.pool.query(
      `INSERT INTO question_bank_entries(
         id,question_version_id,difficulty_band,complexity_band,visibility,
         source_type,content_fingerprint,status,published_at,created_by)
       VALUES($1,$2,$3,$4,'shared','material_question',$5,'published',now(),$6)`,
      [
        entryId,
        questionVersionId,
        options.bucket.difficulty,
        options.bucket.complexity,
        `fingerprint-${randomUUID()}`,
        context.adminId,
      ],
    );
    await db.pool.query(
      "INSERT INTO question_skill_links(entry_id,skill_id,is_primary) VALUES($1,$2,true)",
      [entryId, context.skillId],
    );
  }
  return { attemptId, questionVersionId };
}

it("zero_evidence_returns_null_metrics_and_keeps_a_snapshot", async () =>
  withTestDb(async (db) => {
    const s = await scenario(db);
    const dto = await new LearningEvaluationService(db).snapshot(
      s.f.admin,
      s.f.scope.studentId,
      WINDOW(),
    );

    expect(dto.sampleSize).toBe(0);
    expect(dto.metrics.confirmedDiagnosis.overall.value).toBeNull();
    expect(dto.metrics.diagnosisCoverage.value).toBeNull();
    expect(dto.metrics.selfCheckSuccess.overall.value).toBeNull();
    expect(dto.metrics.independentNewCorrect.value).toBeNull();
    expect(dto.metrics.independentCoverage.value).toBeNull();
    expect(dto.metrics.delayedReview.completion.value).toBeNull();
    expect(dto.metrics.timing.coverage.value).toBeNull();
    expect(dto.metrics.timing.reliable.value).toBeNull();
    expect(dto.metrics.questionQuality.value).toBeNull();
    expect(dto.metrics.efficiency).toEqual([]);
    expect(dto.groupReference).toMatchObject({
      enabled: false,
      available: false,
      reasonCodes: ["DISABLED"],
    });
    expect(dto.staleEvidenceCount).toBe(0);

    const rows = await db.pool.query<{ sample_size: number }>(
      "SELECT sample_size FROM learning_evaluations WHERE student_id=$1",
      [s.f.scope.studentId],
    );
    expect(rows.rows).toEqual([{ sample_size: 0 }]);
  }));

it("partial_timing_counts_as_coverage_but_never_as_a_reliable_trend", async () =>
  withTestDb(async (db) => {
    const s = await scenario(db);
    await seedAttempt(db, s.context, {
      createdAt: at(-2),
      timing: { quality: "partial", ms: 1_000 },
    });
    await seedAttempt(db, s.context, {
      createdAt: at(-1),
      timing: { quality: "partial", ms: 2_000 },
    });

    const dto = await new LearningEvaluationService(db).snapshot(
      s.f.admin,
      s.f.scope.studentId,
      WINDOW(),
    );
    expect(dto.sampleSize).toBe(2);
    expect(dto.metrics.timing.coverage).toEqual({
      numerator: 2,
      denominator: 2,
      value: 1,
    });
    expect(dto.metrics.timing.reliable).toEqual({
      numerator: 0,
      denominator: 2,
      value: 0,
    });
    expect(dto.metrics.efficiency).toEqual([]);
  }));

it("evaluation_rejects_non_admin_and_unknown_students", async () =>
  withTestDb(async (db) => {
    const s = await scenario(db);
    const service = new LearningEvaluationService(db);

    await expect(
      service.snapshot(
        { userId: s.f.scope.actor.userId, role: "student" },
        s.f.scope.studentId,
        WINDOW(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.snapshot(s.f.admin, randomUUID(), WINDOW()),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.snapshot(s.f.admin, "not-a-uuid", WINDOW()),
    ).rejects.toMatchObject({ status: 422 });
  }));

it("evidence_after_the_window_never_enters_the_snapshot", async () =>
  withTestDb(async (db) => {
    const s = await scenario(db);
    await seedAttempt(db, s.context, {
      createdAt: at(-1),
      exposure: "none",
      timing: { quality: "reliable", ms: 5_000 },
    });
    await seedAttempt(db, s.context, {
      createdAt: at(3),
      exposure: "none",
      timing: { quality: "reliable", ms: 5_000 },
    });

    const dto = await new LearningEvaluationService(db).snapshot(
      s.f.admin,
      s.f.scope.studentId,
      WINDOW(),
    );
    expect(dto.sampleSize).toBe(1);
    expect(dto.metrics.independentNewCorrect).toEqual({
      numerator: 1,
      denominator: 1,
      value: 1,
    });
  }));

it("one_student_cannot_open_the_group_reference_gate_alone", async () =>
  withTestDb(async (db) => {
    const s = await scenario(db);
    const bucket = { difficulty: "medium", complexity: 2 };
    for (let index = 0; index < 100; index += 1) {
      await seedAttempt(db, s.context, {
        createdAt: at(-1),
        exposure: "none",
        timing: { quality: "reliable", ms: 5_000 },
        bucket,
      });
    }

    const dto = await new LearningEvaluationService(db, {
      groupReferenceEnabled: true,
    }).snapshot(s.f.admin, s.f.scope.studentId, WINDOW());

    expect(dto.sampleSize).toBe(100);
    expect(dto.groupReference).toMatchObject({
      enabled: true,
      available: false,
      studentCount: 1,
      sampleCount: 5,
      maxSamplesPerStudent: 5,
      reasonCodes: ["STUDENTS_BELOW_MINIMUM", "SAMPLES_BELOW_MINIMUM"],
    });
  }));

it("revoking_evidence_appends_a_new_snapshot_without_rewriting_the_old_one", async () =>
  withTestDb(async (db) => {
    const s = await scenario(db);
    const seeded = await seedAttempt(db, s.context, {
      createdAt: at(-1),
      exposure: "none",
      timing: { quality: "reliable", ms: 5_000 },
    });
    const service = new LearningEvaluationService(db);

    const first = await service.snapshot(
      s.f.admin,
      s.f.scope.studentId,
      WINDOW(),
    );
    expect(first.sampleSize).toBe(1);
    expect(first.staleEvidenceCount).toBe(0);

    await db.pool.query(
      "INSERT INTO evidence_invalidations(student_id,evidence_version_id,reason) VALUES($1,$2,'诊断复核撤销')",
      [s.f.scope.studentId, seeded.questionVersionId],
    );

    const second = await service.snapshot(
      s.f.admin,
      s.f.scope.studentId,
      WINDOW(),
    );
    expect(second.sampleSize).toBe(0);
    expect(second.metrics.independentNewCorrect.value).toBeNull();
    expect(second.staleEvidenceCount).toBe(1);

    const rows = await db.pool.query<{
      sample_size: number;
      stale_evidence_count: number;
      metrics: { independentNewCorrect: { numerator: number; denominator: number } };
    }>(
      `SELECT sample_size,stale_evidence_count,metrics
       FROM learning_evaluations WHERE student_id=$1`,
      [s.f.scope.studentId],
    );
    expect(rows.rows).toHaveLength(2);
    const oldRow = rows.rows.find((row) => row.sample_size === 1)!;
    expect(oldRow.stale_evidence_count).toBe(0);
    expect(oldRow.metrics.independentNewCorrect).toEqual({
      numerator: 1,
      denominator: 1,
      value: 1,
    });
    expect(rows.rows.find((row) => row.sample_size === 0)).toMatchObject({
      stale_evidence_count: 1,
    });
  }));
