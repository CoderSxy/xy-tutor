import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { buildApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { SkillService } from "../../apps/server/src/modules/question-bank/skills.js";
import { SelectionService } from "../../apps/server/src/modules/learning-profile/selection-service.js";
import type { Database } from "../../packages/db/src/client.js";

type Fixture = Awaited<ReturnType<typeof catalogFixture>>;

type Context = {
  f: Fixture;
  db: Database;
  skills: SkillService;
  skillId: string;
  taskId: string;
  selection: SelectionService;
};

let sequence = 0;

async function setup(db: Database): Promise<Context> {
  const f = await catalogFixture(db);
  const skills = new SkillService(db);
  const skill = await skills.create(f.admin, {
    code: `fraction_add_${(sequence += 1)}`,
    name: "分数加法",
  });
  const item = await seedKnowledgeItem(db, f.admin.userId);
  await skills.linkContent(f.admin, skill.id, item);
  const task = await db.pool.query(
    "INSERT INTO learning_tasks(student_id,kind) VALUES($1,'free_question') RETURNING id",
    [f.scope.studentId],
  );
  return {
    f,
    db,
    skills,
    skillId: skill.id,
    taskId: task.rows[0]!.id as string,
    selection: new SelectionService(db, f.auth),
  };
}

async function seedKnowledgeItem(db: Database, actorId: string) {
  const batch = await db.pool.query(
    "INSERT INTO knowledge_batches(actor_id) VALUES($1) RETURNING id",
    [actorId],
  );
  const run = await db.pool.query(
    "INSERT INTO knowledge_parse_runs(batch_id,status) VALUES($1,'succeeded') RETURNING id",
    [batch.rows[0]!.id],
  );
  return (
    await db.pool.query(
      `INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status,published_at)
       VALUES($1,$2,'分数加法','分母不变分子相加','published',now()) RETURNING id`,
      [batch.rows[0]!.id, run.rows[0]!.id],
    )
  ).rows[0]!.id as string;
}

async function seedCandidate(
  c: Context,
  input: {
    difficulty?: "easy" | "medium" | "challenge";
    visibility?: "shared" | "owner_only";
    ownerId?: string;
    status?: "published" | "withdrawn";
    family?: string;
    studentId?: string | null;
    link?: boolean;
  } = {},
) {
  sequence += 1;
  const n = sequence;
  const question = await c.db.pool.query(
    "INSERT INTO questions(student_id,source_type) VALUES($1,'tutoring') RETURNING id",
    [input.studentId === undefined ? c.f.scope.studentId : input.studentId],
  );
  const version = await c.db.pool.query(
    `INSERT INTO question_versions(question_id,version_no,stem,reference_answer)
     VALUES($1,1,$2,'答案') RETURNING id`,
    [question.rows[0]!.id, `题目 ${n}`],
  );
  const questionVersionId = version.rows[0]!.id as string;
  const entry = await c.db.pool.query(
    `INSERT INTO question_bank_entries(
       question_version_id,difficulty_band,complexity_band,visibility,owner_id,
       source_type,template_family,content_fingerprint,status,published_at,created_by)
     VALUES($1,$2,1,$3,$4,'tutoring',$5,$6,$7,
            CASE WHEN $7::text='published' THEN now() ELSE NULL END,$8)
     RETURNING id`,
    [
      questionVersionId,
      input.difficulty ?? "easy",
      input.visibility ?? "shared",
      input.visibility === "owner_only"
        ? (input.ownerId ?? c.f.admin.userId)
        : null,
      input.family ?? "family-a",
      `adaptive-${n}`,
      input.status ?? "published",
      c.f.admin.userId,
    ],
  );
  if (input.link !== false)
    await c.db.pool.query(
      "INSERT INTO question_skill_links(entry_id,skill_id,is_primary) VALUES($1,$2,true)",
      [entry.rows[0]!.id, c.skillId],
    );
  await c.db.pool.query(
    `INSERT INTO question_references(
       question_version_id,answer,answer_type,requires_working,verification,evidence)
     VALUES($1,'答案','numeric',false,'verified','{}')`,
    [questionVersionId],
  );
  return {
    questionId: question.rows[0]!.id as string,
    questionVersionId,
    entryId: entry.rows[0]!.id as string,
  };
}

async function seedProfile(
  c: Context,
  input: {
    band?: "repair" | "consolidation" | "advance";
    version?: number;
    stale?: boolean;
    correct?: number;
    determinate?: number;
    efficiency?: Record<string, unknown>;
    studentId?: string;
    skillId?: string;
  } = {},
) {
  const row = await c.db.pool.query(
    `INSERT INTO learning_profiles(
       student_id,skill_id,version,training_band,stale,knowledge_stats,efficiency)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      input.studentId ?? c.f.scope.studentId,
      input.skillId ?? c.skillId,
      input.version ?? 1,
      input.band ?? "repair",
      input.stale ?? false,
      JSON.stringify({
        recentIndependentCorrect: input.correct ?? 0,
        recentDeterminateCount: input.determinate ?? 0,
      }),
      JSON.stringify(input.efficiency ?? {}),
    ],
  );
  return row.rows[0]!.id as string;
}

async function secondStudent(f: Fixture) {
  const invitation = await f.auth.invite(f.admin, { login: "student2" });
  const activated = await f.auth.activate({
    token: invitation.activationToken,
    password: "long-test-password",
  });
  return f.auth.requireStudentAccess(
    { userId: activated.userId, role: "student" },
    activated.studentId!,
  );
}

async function formalItems(db: Database, taskId: string) {
  return (
    await db.pool.query(
      "SELECT count(*)::int AS total FROM task_items WHERE task_id=$1 AND role IN ('original','variant')",
      [taskId],
    )
  ).rows[0]!.total as number;
}

it("同 requestKey 同载荷返回同一决策，不同载荷返回冲突", async () =>
  withTestDb(async (db) => {
    const c = await setup(db);
    await seedProfile(c);
    await seedCandidate(c);
    const first = await c.selection.next(c.f.scope, c.taskId, {
      requestKey: "k1",
      expectedProfileVersion: 1,
    });
    const again = await c.selection.next(c.f.scope, c.taskId, {
      requestKey: "k1",
      expectedProfileVersion: 1,
    });
    expect(again).toEqual(first);
    expect(await formalItems(db, c.taskId)).toBe(1);
    await expect(
      c.selection.next(c.f.scope, c.taskId, {
        requestKey: "k1",
        expectedProfileVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(await formalItems(db, c.taskId)).toBe(1);
  }));

it("并发下第 5 题成功、第 6 题被拒绝", async () =>
  withTestDb(async (db) => {
    const c = await setup(db);
    await seedProfile(c);
    for (let i = 0; i < 6; i += 1) await seedCandidate(c);
    for (let i = 0; i < 4; i += 1)
      await c.selection.next(c.f.scope, c.taskId, {
        requestKey: `fill-${i}`,
        expectedProfileVersion: 1,
      });
    const results = await Promise.allSettled([
      c.selection.next(c.f.scope, c.taskId, {
        requestKey: "race-a",
        expectedProfileVersion: 1,
      }),
      c.selection.next(c.f.scope, c.taskId, {
        requestKey: "race-b",
        expectedProfileVersion: 1,
      }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      reason: { code: "CONFLICT", status: 409 },
    });
    expect(await formalItems(db, c.taskId)).toBe(5);
  }));

it("不同学生可以用同一个 requestKey 各自记录", async () =>
  withTestDb(async (db) => {
    const c = await setup(db);
    await seedProfile(c);
    await seedCandidate(c);
    const other = await secondStudent(c.f);
    const task = await db.pool.query(
      "INSERT INTO learning_tasks(student_id,kind) VALUES($1,'free_question') RETURNING id",
      [other.studentId],
    );
    await seedProfile(c, { studentId: other.studentId });
    await seedCandidate(c, { studentId: other.studentId });
    const mine = await c.selection.next(c.f.scope, c.taskId, {
      requestKey: "shared-key",
      expectedProfileVersion: 1,
    });
    const theirs = await c.selection.next(other, task.rows[0]!.id as string, {
      requestKey: "shared-key",
      expectedProfileVersion: 1,
    });
    expect(mine.status).toBe("selected");
    expect(theirs.status).toBe("selected");
    expect(theirs.id).not.toBe(mine.id);
  }));

it("过滤他人私有题与已撤回题", async () =>
  withTestDb(async (db) => {
    const c = await setup(db);
    await seedProfile(c);
    const other = await secondStudent(c.f);
    await seedCandidate(c, {
      visibility: "owner_only",
      ownerId: other.studentId,
    });
    await seedCandidate(c, { status: "withdrawn" });
    const empty = await c.selection.next(c.f.scope, c.taskId, {
      requestKey: "filtered",
      expectedProfileVersion: 1,
    });
    expect(empty.status).toBe("insufficient_pool");
    expect(await formalItems(db, c.taskId)).toBe(0);
    const visible = await seedCandidate(c);
    const picked = await c.selection.next(c.f.scope, c.taskId, {
      requestKey: "filtered-2",
      expectedProfileVersion: 1,
    });
    expect(picked.status).toBe("selected");
    expect(picked.questionVersionId).toBe(visible.questionVersionId);
  }));

it("画像 stale 时回到等待诊断且不新增题目", async () =>
  withTestDb(async (db) => {
    const c = await setup(db);
    await seedProfile(c, { stale: true });
    await seedCandidate(c);
    const decision = await c.selection.next(c.f.scope, c.taskId, {
      requestKey: "stale",
      expectedProfileVersion: 1,
    });
    expect(decision.status).toBe("awaiting_diagnosis");
    expect(decision.questionVersionId).toBeNull();
    expect(await formalItems(db, c.taskId)).toBe(0);
  }));

it("没有候选时记录 insufficient_pool 与排除原因", async () =>
  withTestDb(async (db) => {
    const c = await setup(db);
    await seedProfile(c);
    const decision = await c.selection.next(c.f.scope, c.taskId, {
      requestKey: "empty",
      expectedProfileVersion: 1,
    });
    expect(decision.status).toBe("insufficient_pool");
    const row = await db.pool.query(
      "SELECT exclusions,candidate_snapshot FROM practice_decisions WHERE id=$1",
      [decision.id],
    );
    expect(row.rows[0]!.exclusions.length).toBeGreaterThan(0);
    expect(row.rows[0]!.candidate_snapshot).toEqual([]);
  }));

it("到期复习优先，且不取消错题的复习时间", async () =>
  withTestDb(async (db) => {
    const c = await setup(db);
    await seedProfile(c);
    await seedCandidate(c);
    const wrong = await seedCandidate(c);
    await db.pool.query(
      `INSERT INTO student_mistakes(student_id,question_id,status,due_at)
       VALUES($1,$2,'pending_correction',now() - interval '1 day')`,
      [c.f.scope.studentId, wrong.questionId],
    );
    const decision = await c.selection.next(c.f.scope, c.taskId, {
      requestKey: "review",
      expectedProfileVersion: 1,
    });
    expect(decision.goal).toBe("review");
    expect(decision.questionVersionId).toBe(wrong.questionVersionId);
    const due = await db.pool.query(
      "SELECT due_at FROM student_mistakes WHERE question_id=$1",
      [wrong.questionId],
    );
    expect(due.rows[0]!.due_at).not.toBeNull();
    expect(new Date(due.rows[0]!.due_at).getTime()).toBeLessThan(Date.now());
  }));

it("之后的画像变化不改变已有决策的回放", async () =>
  withTestDb(async (db) => {
    const c = await setup(db);
    await seedProfile(c);
    await seedCandidate(c);
    const decision = await c.selection.next(c.f.scope, c.taskId, {
      requestKey: "frozen",
      expectedProfileVersion: 1,
    });
    await db.pool.query(
      "UPDATE learning_profiles SET version=9,training_band='advance',stale=true WHERE student_id=$1",
      [c.f.scope.studentId],
    );
    const replayed = await c.selection.replay(c.f.scope, decision.id);
    expect(replayed).toEqual(decision);
    expect(replayed.profileVersion).toBe(1);
  }));

it("慢而正确不直接降档，只提示方法优化", async () =>
  withTestDb(async (db) => {
    const c = await setup(db);
    await seedProfile(c, {
      efficiency: {
        status: "observed",
        direction: "slower",
        sampleCount: 3,
        medianMs: 90_000,
        timeRatio: 1.6,
        reasonCodes: ["slower_than_baseline"],
      },
    });
    await seedCandidate(c);
    const decision = await c.selection.next(c.f.scope, c.taskId, {
      requestKey: "slow-correct",
      expectedProfileVersion: 1,
    });
    expect(decision.goal).toBe("repair");
    expect(decision.difficulty).toBe("easy");
    expect(decision.explanation).toContain("偏慢");
    const row = await db.pool.query(
      "SELECT training_band,version FROM learning_profiles WHERE student_id=$1",
      [c.f.scope.studentId],
    );
    expect(row.rows[0]!.training_band).toBe("repair");
    expect(row.rows[0]!.version).toBe(1);
  }));

it("画像版本不匹配时要求刷新，不写入决策", async () =>
  withTestDb(async (db) => {
    const c = await setup(db);
    await seedProfile(c);
    await seedCandidate(c);
    await expect(
      c.selection.next(c.f.scope, c.taskId, {
        requestKey: "stale-version",
        expectedProfileVersion: 7,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    const rows = await db.pool.query(
      "SELECT count(*)::int AS total FROM practice_decisions",
    );
    expect(rows.rows[0]!.total).toBe(0);
  }));

it("新路由只在开关打开时存在", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const task = await db.pool.query(
      "INSERT INTO learning_tasks(student_id,kind) VALUES($1,'free_question') RETURNING id",
      [f.scope.studentId],
    );
    const session = await f.auth.login({
      login: "student",
      password: "long-test-password",
    });
    const headers = {
      cookie: `xy_session=${session.sessionToken}`,
      origin: "http://localhost:5173",
    };
    const off = buildApp({
      database: db,
      config: loadConfig({ NODE_ENV: "test" }),
    });
    try {
      const response = await off.inject({
        method: "POST",
        url: `/api/tasks/${task.rows[0]!.id}/next-practice`,
        headers,
        payload: { requestKey: "route", expectedProfileVersion: 1 },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await off.close();
    }
    const on = buildApp({
      database: db,
      config: loadConfig({
        NODE_ENV: "test",
        TUTOR_SELF_CHECK_ENABLED: "true",
        ADAPTIVE_PRACTICE_ENABLED: "true",
      }),
    });
    try {
      const response = await on.inject({
        method: "POST",
        url: `/api/tasks/${task.rows[0]!.id}/next-practice`,
        headers,
        payload: { requestKey: "route-replay", expectedProfileVersion: 1 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: "awaiting_diagnosis",
        profileVersion: 1,
      });
    } finally {
      await on.close();
    }
  }));
