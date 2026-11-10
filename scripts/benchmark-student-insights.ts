// 性能基准：只在隔离的 _test 数据库的临时 schema 中造数，结束后自动清理。
// 用法：pnpm benchmark:student-insights [--students=1000] [--attempts-per-student=100] [--runs=100] [--out=path]
import os from "node:os";
import { writeFileSync } from "node:fs";
import { withTestDb } from "../tests/helpers/database.js";
import type { Database } from "../packages/db/src/client.js";
import { InsightQueryService } from "../apps/server/src/modules/student-insights/queries.js";
import { resolveInsightRange } from "../apps/server/src/modules/student-insights/metrics.js";
import {
  insightListQuerySchema,
  type InsightListQuery,
} from "../packages/contracts/src/student-insights.js";

type Flags = {
  students: number;
  attemptsPerStudent: number;
  warmup: number;
  runs: number;
  out: string | null;
};

function positiveInt(name: string, value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw Error(`--${name} 必须是正整数`);
  return parsed;
}

function parseArgs(argv: string[]): Flags {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw Error(`未知参数：${arg}（请使用 --key=value）`);
    flags.set(match[1]!, match[2]!);
  }
  const known = new Set([
    "students",
    "attempts-per-student",
    "warmup",
    "runs",
    "out",
  ]);
  for (const key of flags.keys())
    if (!known.has(key)) throw Error(`未知参数：--${key}`);
  return {
    students: positiveInt("students", flags.get("students"), 1000),
    attemptsPerStudent: positiveInt(
      "attempts-per-student",
      flags.get("attempts-per-student"),
      100,
    ),
    warmup: positiveInt("warmup", flags.get("warmup"), 20),
    runs: positiveInt("runs", flags.get("runs"), 100),
    out: flags.get("out") ?? null,
  };
}

const STUDENT_ID = `('00000000-0000-4000-8000-' || lpad(to_hex(s), 12, '0'))::uuid`;
const QUESTION_ID = `('10000000-0000-4000-8000-' || lpad(to_hex((s - 1) * $2 + k), 12, '0'))::uuid`;
const ATTEMPT_ID = `('20000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid`;

async function seed(
  db: Database,
  studentCount: number,
  perStudent: number,
) {
  const exec = async (sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows;
  await exec(
    `INSERT INTO users(login,password_hash,role)
     VALUES('bench-admin','x','admin') RETURNING id`,
  );
  const adminId = (
    await exec(`SELECT id FROM users WHERE login = 'bench-admin'`)
  )[0].id as string;
  const fileId = (
    await exec(
      `INSERT INTO files(owner_id,purpose,name,content_type,size,object_key)
       VALUES($1,'textbook','bench.pdf','application/pdf',1,'bench-object')
       RETURNING id`,
      [adminId],
    )
  )[0].id as string;
  const editionId = (
    await exec(`INSERT INTO curriculum_editions(name) VALUES('bench') RETURNING id`)
  )[0].id as string;
  const gradeId = (
    await exec(`INSERT INTO grades(name) VALUES('bench') RETURNING id`)
  )[0].id as string;
  const subjectId = (
    await exec(`INSERT INTO subjects(name) VALUES('bench') RETURNING id`)
  )[0].id as string;
  const textbookId = (
    await exec(
      `INSERT INTO textbooks(title,edition_id,grade_id,subject_id,term,publication_year)
       VALUES('bench',$1,$2,$3,'下册',2024) RETURNING id`,
      [editionId, gradeId, subjectId],
    )
  )[0].id as string;
  const revisionId = (
    await exec(
      `INSERT INTO textbook_revisions(textbook_id,file_id,revision_no,status)
       VALUES($1,$2,1,'published') RETURNING id`,
      [textbookId, fileId],
    )
  )[0].id as string;

  await db.pool.query(
    `INSERT INTO student_profiles(id,display_name,timezone,preferences,created_at)
     SELECT ${STUDENT_ID}, 'bench-' || s, 'Asia/Shanghai', '{}'::jsonb,
            now() - interval '120 days'
     FROM generate_series(1, $1) s`,
    [studentCount],
  );
  await db.pool.query(
    `INSERT INTO questions(id,student_id,revision_id,source_type)
     SELECT ${QUESTION_ID}, ${STUDENT_ID}, $3, 'teacher'
     FROM generate_series(1, $1) s, generate_series(1, $2) k`,
    [studentCount, perStudent, revisionId],
  );
  await db.pool.query(
    `INSERT INTO question_versions(question_id,version_no,stem,knowledge_point)
     SELECT id, 1, 'bench', '分数' FROM questions`,
  );
  await db.pool.query(
    `INSERT INTO learning_tasks(student_id,revision_id,kind,title,status,created_at,updated_at)
     SELECT ${STUDENT_ID}, $2, 'practice', 'bench', 'completed',
            now() - make_interval(days => (k % 28)), now()
     FROM generate_series(1, $1) s, generate_series(1, 10) k`,
    [studentCount, revisionId],
  );

  const attemptCount = studentCount * perStudent;
  await db.pool.query(
    `INSERT INTO attempts(id,student_id,question_version_id,request_key,answer,created_at)
     SELECT ${ATTEMPT_ID}, ${STUDENT_ID}, v.id,
            gen_random_uuid()::text, 'bench',
            now() - make_interval(days => (g % 28))
     FROM (
       SELECT s, k, (s - 1) * $2 + k AS g
       FROM generate_series(1, $1) s, generate_series(1, $2) k
     ) rows
     JOIN question_versions v
       ON v.question_id = ${QUESTION_ID}
     ORDER BY g`,
    [studentCount, perStudent],
  );
  await db.pool.query(
    `INSERT INTO assessments(
       attempt_id,correctness,verification,hint_dependency,method,
       verifier_version,evidence,created_at)
     SELECT id, 'correct', 'verified', 'none', 'model', 'v1', '{}', created_at
     FROM attempts`,
  );
  await db.pool.query(
    `INSERT INTO student_learning_events(
       student_id,actor_id,event_type,source_type,source_id,task_id,
       revision_id,occurred_at,source_origin,created_at)
     SELECT student_id, $1, 'answer_submitted', 'attempt', id, NULL,
            $2, created_at, 'live', created_at
     FROM attempts`,
    [adminId, revisionId],
  );
  await db.pool.query(
    `INSERT INTO student_mistakes(student_id,question_id,status,created_at)
     SELECT ${STUDENT_ID}, ${QUESTION_ID}, 'pending_correction',
            now() - interval '3 days'
     FROM generate_series(1, $1) s, generate_series(1, 2) k`,
    [studentCount, perStudent],
  );
  await db.pool.query(
    `INSERT INTO student_daily_visits(student_id,local_date,timezone,first_seen_at,last_seen_at)
     SELECT ${STUDENT_ID},
            (now() AT TIME ZONE 'Asia/Shanghai')::date - d,
            'Asia/Shanghai', now(), now()
     FROM generate_series(1, $1) s, generate_series(0, 27) d
     ON CONFLICT DO NOTHING`,
    [studentCount],
  );

  const range = resolveInsightRange({});
  await db.pool.query(
    `INSERT INTO student_insight_collection_state(id,learning_started_at,visits_started_at)
     VALUES(1, now() - interval '120 days', now() - interval '120 days')`,
  );
  await db.pool.query(
    `INSERT INTO student_insight_backfills(version,from_date,to_date,status,updated_at)
     VALUES('bench',$1,$2,'completed',now())`,
    [range.from, range.to],
  );

  const counts = (
    await db.pool.query(
      `SELECT
         (SELECT count(*)::int FROM student_profiles) AS students,
         (SELECT count(*)::int FROM attempts) AS attempts,
         (SELECT count(*)::int FROM assessments) AS assessments,
         (SELECT count(*)::int FROM student_learning_events) AS events,
         (SELECT count(*)::int FROM student_mistakes) AS mistakes`,
    )
  ).rows[0];
  const studentIds = (
    await db.pool.query(`SELECT id FROM student_profiles ORDER BY id LIMIT 1`)
  ).rows.map((row) => row.id as string);
  return {
    counts: {
      students: Number(counts.students),
      attempts: Number(counts.attempts),
      assessments: Number(counts.assessments),
      events: Number(counts.events),
      mistakes: Number(counts.mistakes),
    },
    actor: { userId: adminId, role: "admin" as const },
    sampleStudentId: studentIds[0]!,
    revisionId,
    range,
    expectedAttempts: attemptCount,
  };
}

async function measure(
  run: () => Promise<unknown>,
  warmup: number,
  runs: number,
) {
  for (let index = 0; index < warmup; index += 1) await run();
  const samples: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (quantile: number) =>
    sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]!;
  return {
    runs,
    p50Ms: round(at(0.5)),
    p95Ms: round(at(0.95)),
    maxMs: round(sorted.at(-1)!),
    meanMs: round(
      samples.reduce((total, value) => total + value, 0) / samples.length,
    ),
  };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

async function explain(
  pool: Database["pool"],
  label: string,
  sql: string,
  params: unknown[],
) {
  const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
  return {
    label,
    plan: result.rows.map((row) => row["QUERY PLAN"] as string).join("\n"),
  };
}

// 与 queries.ts 中的实现保持一致，便于定位瓶颈。
const VALID_ATTEMPT = `NOT EXISTS (
  SELECT 1 FROM evidence_invalidations i
  WHERE i.student_id = a.student_id
    AND (i.evidence_version_id = a.question_version_id
      OR i.evidence_version_id = a.message_version_id)
)`;
const EVENT_SOURCE_EXISTS = `CASE e.source_type
  WHEN 'attempt' THEN EXISTS(SELECT 1 FROM attempts x WHERE x.id = e.source_id)
  WHEN 'message' THEN EXISTS(SELECT 1 FROM messages x WHERE x.id = e.source_id)
  WHEN 'material' THEN EXISTS(SELECT 1 FROM materials x WHERE x.id = e.source_id)
  ELSE false
END`;

const flags = parseArgs(process.argv.slice(2));
await withTestDb(async (db) => {
  const seedStarted = performance.now();
  const seeded = await seed(db, flags.students, flags.attemptsPerStudent);
  const seedMs = round(performance.now() - seedStarted);
  await db.pool.query(
    "ANALYZE student_profiles, attempts, assessments, learning_tasks, student_mistakes, student_learning_events, student_daily_visits",
  );
  if (seeded.counts.attempts !== seeded.expectedAttempts)
    throw Error(
      `造数校验失败：期望 ${seeded.expectedAttempts} 条作答，实际 ${seeded.counts.attempts}`,
    );

  const now = new Date();
  const service = new InsightQueryService(db, () => now);
  const query = (input: Record<string, unknown>): InsightListQuery =>
    insightListQuerySchema.parse(input);
  const cases: { name: string; input: InsightListQuery }[] = [
    { name: "list:default", input: query({}) },
    { name: "list:active_days", input: query({ sort: "active_days" }) },
    {
      name: "list:first_attempt_accuracy",
      input: query({ sort: "first_attempt_accuracy" }),
    },
    { name: "list:search", input: query({ q: "bench-500" }) },
    {
      name: "list:pending_corrections",
      input: query({ attention: "pending_corrections_10" }),
    },
  ];

  const results: {
    name: string;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    meanMs: number;
    runs: number;
    total: number;
  }[] = [];
  for (const testCase of cases) {
    const stats = await measure(
      () => service.list(seeded.actor, testCase.input),
      flags.warmup,
      flags.runs,
    );
    const total = (await service.list(seeded.actor, testCase.input)).total;
    results.push({ name: testCase.name, ...stats, total });
  }

  const overviewStats = await measure(
    () =>
      service.overview(
        { actor: seeded.actor, studentId: seeded.sampleStudentId },
        { from: seeded.range.from, to: seeded.range.to },
      ),
    flags.warmup,
    flags.runs,
  );

  const plans = [];
  plans.push(
    await explain(
      db.pool,
      "attempt-aggregates",
      `SELECT a.student_id, count(*)::int AS attempts,
         count(DISTINCT v.question_id)::int AS questions
       FROM attempts a
       JOIN question_versions v ON v.id = a.question_version_id
       JOIN questions q ON q.id = v.question_id
       LEFT JOIN learning_tasks t ON t.id = a.task_id
       WHERE a.created_at >= $1 AND a.created_at < $2
         AND (a.task_id IS NULL OR t.deleted_at IS NULL)
         AND ($3::uuid IS NULL OR q.revision_id = $3)
         AND ${VALID_ATTEMPT}
       GROUP BY a.student_id`,
      [seeded.range.start, seeded.range.endExclusive, null],
    ),
  );
  plans.push(
    await explain(
      db.pool,
      "event-aggregates",
      `SELECT e.student_id,
         count(DISTINCT (e.occurred_at AT TIME ZONE 'Asia/Shanghai')::date)
           FILTER (WHERE e.occurred_at >= $1 AND e.occurred_at < $2)::int AS "activeDays",
         max(e.occurred_at) AS "lastLearningAt"
       FROM student_learning_events e
       LEFT JOIN learning_tasks t ON t.id = e.task_id
       WHERE (e.task_id IS NULL OR t.deleted_at IS NULL)
         AND ($3::uuid IS NULL OR e.revision_id = $3)
         AND ${EVENT_SOURCE_EXISTS}
       GROUP BY e.student_id`,
      [seeded.range.start, seeded.range.endExclusive, null],
    ),
  );

  const version = (
    await db.pool.query(
      `SELECT version() AS pg, current_setting('server_version') AS server`,
    )
  ).rows[0];
  const report = {
    generatedAt: new Date().toISOString(),
    machine: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model ?? "unknown",
      cores: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      node: process.version,
      postgres: version.server,
      postgresVersion: version.pg,
    },
    dataset: {
      ...seeded.counts,
      target: {
        students: flags.students,
        attemptsPerStudent: flags.attemptsPerStudent,
      },
      range: { from: seeded.range.from, to: seeded.range.to },
      seedMs,
    },
    protocol: { warmup: flags.warmup, runs: flags.runs },
    results,
    overview: { name: "overview:sample-student", ...overviewStats },
    target: "p95 < 1000ms",
    passed: [...results, { name: "overview", ...overviewStats }].every(
      (result) => result.p95Ms < 1000,
    ),
    plans,
  };
  const json = JSON.stringify(report, null, 2);
  if (flags.out) writeFileSync(flags.out, json + "\n");
  console.log(json);
});
