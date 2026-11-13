import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { SkillService } from "../../apps/server/src/modules/question-bank/skills.js";
import { LearningProfileService } from "../../apps/server/src/modules/learning-profile/service.js";
import { invalidateDerivedEvidence } from "../../apps/server/src/modules/learning-profile/invalidation.js";
import type { Database } from "../../packages/db/src/client.js";

type Fixture = Awaited<ReturnType<typeof catalogFixture>>;

type Context = {
  f: Fixture;
  db: Database;
  skills: SkillService;
  admin: { userId: string; role: "admin" };
  taskId: string;
};

type SeedInput = {
  skillId: string;
  correct: boolean;
  at: string;
  family?: string;
  firstAttemptMs?: number;
  hint?: "none" | "guided" | "solution_exposed";
  exposure?: "none" | "guided" | "solution_exposed";
  verification?: "verified" | "pending";
};

let sequence = 0;

async function setup(db: Database): Promise<Context> {
  const f = await catalogFixture(db);
  const skills = new SkillService(db);
  const task = await db.pool.query(
    `INSERT INTO learning_tasks(student_id, kind) VALUES($1,'free_question') RETURNING id`,
    [f.scope.studentId],
  );
  return {
    f,
    db,
    skills,
    admin: { userId: f.admin.userId, role: "admin" },
    taskId: task.rows[0]!.id as string,
  };
}

async function createSkill(c: Context, code: string) {
  return c.skills.create(c.admin, { code, name: code });
}

async function seedAttempt(
  c: Context,
  input: SeedInput,
): Promise<{ attemptId: string; questionVersionId: string }> {
  sequence += 1;
  const n = sequence;
  const at = new Date(input.at);
  const question = await c.db.pool.query(
    `INSERT INTO questions(student_id, source_type) VALUES($1,'tutoring') RETURNING id`,
    [c.f.scope.studentId],
  );
  const version = await c.db.pool.query(
    `INSERT INTO question_versions(
       question_id, version_no, stem, reference_answer, rubric, verification, created_at)
     VALUES($1,1,$2,'答案','{}',$3,$4) RETURNING id`,
    [
      question.rows[0]!.id,
      `题目 ${n}`,
      input.verification ?? "verified",
      at,
    ],
  );
  const questionVersionId = version.rows[0]!.id as string;
  const entry = await c.db.pool.query(
    `INSERT INTO question_bank_entries(
       question_version_id, difficulty_band, complexity_band, visibility,
       source_type, template_family, content_fingerprint, status, published_at,
       created_by, created_at)
     VALUES($1,'medium',2,'shared','manual',$2,$3,'published',$4,$5,$4) RETURNING id`,
    [
      questionVersionId,
      input.family ?? "family-a",
      `profile-${n}`,
      at,
      c.f.admin.userId,
    ],
  );
  await c.db.pool.query(
    `INSERT INTO question_skill_links(entry_id, skill_id, is_primary)
     VALUES($1,$2,true)`,
    [entry.rows[0]!.id, input.skillId],
  );
  await c.db.pool.query(
    `INSERT INTO question_references(
       question_version_id, answer, answer_type, requires_working, verification, evidence, created_at)
     VALUES($1,'答案','numeric',false,'verified','{}',$2)`,
    [questionVersionId, at],
  );
  await c.db.pool.query(
    `INSERT INTO tutoring_episodes(
       student_id, task_id, question_version_id, request_key, state,
       exposure, prior_exposure, started_at, ended_at, created_at, updated_at)
     VALUES($1,$2,$3,$4,'finished',$5,false,$6,$6,$6,$6)`,
    [
      c.f.scope.studentId,
      c.taskId,
      questionVersionId,
      `episode-${n}`,
      input.exposure ?? "none",
      at,
    ],
  );
  const attempt = await c.db.pool.query(
    `INSERT INTO attempts(student_id, question_version_id, request_key, answer, created_at)
     VALUES($1,$2,$3,'答案',$4) RETURNING id`,
    [c.f.scope.studentId, questionVersionId, `attempt-${n}`, at],
  );
  const attemptId = attempt.rows[0]!.id as string;
  await c.db.pool.query(
    `INSERT INTO assessments(
       attempt_id, correctness, verification, hint_dependency, method,
       verifier_version, evidence, created_at)
     VALUES($1,$2,'verified',$3,'exact','v1','{}',$4)`,
    [attemptId, input.correct ? "correct" : "incorrect", input.hint ?? "none", at],
  );
  await c.db.pool.query(
    `INSERT INTO attempt_timing_snapshots(
       attempt_id, version, first_attempt_ms, quality, created_at)
     VALUES($1,1,$2,'reliable',$3)`,
    [attemptId, input.firstAttemptMs ?? 60_000, at],
  );
  return { attemptId, questionVersionId };
}

function profiles(c: Context) {
  return new LearningProfileService(c.db, c.f.auth);
}

async function withdraw(c: Context, versionId: string, reason: string) {
  await c.db.pool.query(
    `INSERT INTO evidence_invalidations(student_id,evidence_version_id,reason)
     VALUES($1,$2,$3)`,
    [c.f.scope.studentId, versionId, reason],
  );
  return invalidateDerivedEvidence(c.db.pool, c.f.scope, versionId, reason);
}

async function evidenceAttemptIds(db: Database) {
  const rows = await db.pool.query(
    `SELECT attempt_id FROM learning_profile_evidence ORDER BY attempt_at, attempt_id`,
  );
  return rows.rows.map((row) => row.attempt_id as string);
}

it("keeps the profile version stable when rebuilding unchanged evidence", async () =>
  withTestDb(async (db) => {
    const c = await setup(db);
    const skill = await createSkill(c, "fraction_add");
    for (let i = 0; i < 5; i += 1)
      await seedAttempt(c, {
        skillId: skill.id,
        correct: true,
        at: `2026-11-0${i + 1}T09:00:00Z`,
      });
    const service = profiles(c);
    const first = await service.rebuildSystem(c.f.scope.studentId, skill.id);
    expect(first.trainingBand).toBe("consolidation");
    const again = await service.rebuildSystem(c.f.scope.studentId, skill.id);
    expect(again).toEqual(first);
    expect(again.version).toBe(first.version);
    expect(await evidenceAttemptIds(db)).toHaveLength(5);
  }));

it("does not replace a first mistake with a later correction", async () =>
  withTestDb(async (db) => {
    const c = await setup(db);
    const skill = await createSkill(c, "fraction_add");
    const wrong = await seedAttempt(c, {
      skillId: skill.id,
      correct: false,
      at: "2026-11-01T09:00:00Z",
    });
    for (let i = 0; i < 3; i += 1)
      await seedAttempt(c, {
        skillId: skill.id,
        correct: true,
        at: `2026-11-0${i + 2}T09:00:00Z`,
      });
    const correction = await c.db.pool.query(
      `INSERT INTO attempts(student_id, question_version_id, request_key, answer, created_at)
       VALUES($1,$2,'attempt-correction','答案','2026-11-05T09:00:00Z') RETURNING id`,
      [c.f.scope.studentId, wrong.questionVersionId],
    );
    await c.db.pool.query(
      `INSERT INTO assessments(
         attempt_id, correctness, verification, hint_dependency, method,
         verifier_version, evidence, created_at)
       VALUES($1,'correct','verified','none','exact','v1','{}','2026-11-05T09:00:00Z')`,
      [correction.rows[0]!.id],
    );
    const profile = await profiles(c).rebuildSystem(
      c.f.scope.studentId,
      skill.id,
    );
    expect(profile.trainingBand).toBe("repair");
    const ids = await evidenceAttemptIds(db);
    expect(ids).toContain(wrong.attemptId);
    expect(ids).not.toContain(correction.rows[0]!.id);
    const stats = await c.db.pool.query(
      `SELECT knowledge_stats FROM learning_profiles WHERE skill_id=$1`,
      [skill.id],
    );
    expect(stats.rows[0]!.knowledge_stats.recentDeterminateCount).toBe(4);
  }));

it("promotes one band per full window instead of chaining", async () =>
  withTestDb(async (db) => {
    const c = await setup(db);
    const skill = await createSkill(c, "fraction_add");
    for (let i = 0; i < 9; i += 1)
      await seedAttempt(c, {
        skillId: skill.id,
        correct: true,
        at: `2026-11-01T${String(9 + i).padStart(2, "0")}:00:00Z`,
      });
    const service = profiles(c);
    const profile = await service.rebuildSystem(c.f.scope.studentId, skill.id);
    expect(profile.trainingBand).toBe("consolidation");
    expect(profile.recentDeterminateCount).toBe(4);
    expect((await service.rebuildSystem(c.f.scope.studentId, skill.id)).trainingBand).toBe(
      "consolidation",
    );
  }));

it("does not borrow promotion evidence across skills", async () =>
  withTestDb(async (db) => {
    const c = await setup(db);
    const strong = await createSkill(c, "fraction_add");
    const untouched = await createSkill(c, "fraction_multiply");
    for (let i = 0; i < 5; i += 1)
      await seedAttempt(c, {
        skillId: strong.id,
        correct: true,
        at: `2026-11-0${i + 1}T09:00:00Z`,
      });
    const service = profiles(c);
    await service.rebuildSystem(c.f.scope.studentId, strong.id);
    const other = await service.rebuildSystem(
      c.f.scope.studentId,
      untouched.id,
    );
    expect(other.trainingBand).toBe("repair");
    expect(other.version).toBe(1);
    expect(other.evidence).toEqual([]);
    expect((await service.get(c.f.scope, strong.id)).trainingBand).toBe(
      "consolidation",
    );
  }));

it("marks a profile stale and queues a rebuild when evidence is withdrawn", async () =>
  withTestDb(async (db) => {
    const c = await setup(db);
    const skill = await createSkill(c, "fraction_add");
    const seeded = await seedAttempt(c, {
      skillId: skill.id,
      correct: true,
      at: "2026-11-01T09:00:00Z",
    });
    await profiles(c).rebuildSystem(c.f.scope.studentId, skill.id);
    const affected = await withdraw(c, seeded.questionVersionId, "question_corrected");
    expect(affected).toEqual([skill.id]);
    const stale = await c.db.pool.query(
      `SELECT stale FROM learning_profiles WHERE skill_id=$1`,
      [skill.id],
    );
    expect(stale.rows[0]!.stale).toBe(true);
    const job = await c.db.pool.query(
      `SELECT payload FROM jobs WHERE kind='learning_profile.rebuild'`,
    );
    expect(job.rows[0]!.payload).toMatchObject({
      studentId: c.f.scope.studentId,
      skillId: skill.id,
      evidenceVersionId: seeded.questionVersionId,
    });
    const rebuilt = await profiles(c).rebuildSystem(
      c.f.scope.studentId,
      skill.id,
    );
    expect(rebuilt.stale).toBe(false);
    expect(rebuilt.evidence).toEqual([]);
  }));

it("drops invalidated samples and keeps the frozen baseline", async () =>
  withTestDb(async (db) => {
    const c = await setup(db);
    const skill = await createSkill(c, "fraction_add");
    const seeded = [];
    for (let i = 0; i < 6; i += 1)
      seeded.push(
        await seedAttempt(c, {
          skillId: skill.id,
          correct: true,
          at: `2026-11-0${Math.floor(i / 2) + 1}T${String(9 + i).padStart(2, "0")}:00:00Z`,
          family: i % 2 === 0 ? "family-a" : "family-b",
        }),
      );
    const service = profiles(c);
    const first = await service.rebuildSystem(c.f.scope.studentId, skill.id);
    expect(first.efficiency.status).toBe("observed");
    const baselineId = first.efficiency.baselineId;
    expect(baselineId).not.toBeNull();
    const baselines = await c.db.pool.query(
      `SELECT id FROM learning_profile_baselines WHERE skill_id=$1`,
      [skill.id],
    );
    expect(baselines.rows).toHaveLength(1);

    await withdraw(c, seeded[0]!.questionVersionId, "question_corrected");
    const rebuilt = await service.rebuildSystem(c.f.scope.studentId, skill.id);
    expect(rebuilt.evidence.map((item) => item.versionId)).not.toContain(
      seeded[0]!.questionVersionId,
    );
    expect(rebuilt.efficiency.baselineId).toBe(baselineId);
    const after = await c.db.pool.query(
      `SELECT id FROM learning_profile_baselines WHERE skill_id=$1`,
      [skill.id],
    );
    expect(after.rows.map((row) => row.id)).toContain(baselineId);
  }));

it("rebuilds deterministically without a model", async () =>
  withTestDb(async (db) => {
    const c = await setup(db);
    const skill = await createSkill(c, "fraction_add");
    for (let i = 0; i < 2; i += 1)
      await seedAttempt(c, {
        skillId: skill.id,
        correct: i === 0,
        at: `2026-11-0${i + 1}T09:00:00Z`,
      });
    const first = await profiles(c).rebuildSystem(
      c.f.scope.studentId,
      skill.id,
    );
    const second = await profiles(c).rebuildSystem(
      c.f.scope.studentId,
      skill.id,
    );
    expect(second).toEqual(first);
    expect(first.trainingBand).toBe("repair");
    expect(first.recentDeterminateCount).toBe(2);
    expect(first.recentIndependentCorrect).toBe(1);
  }));
