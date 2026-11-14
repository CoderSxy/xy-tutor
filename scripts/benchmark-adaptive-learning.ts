// 性能基准：只在隔离的 _test 数据库的临时 schema 中造数，结束后自动清理。
// 用法：pnpm benchmark:adaptive-learning [--students=100] [--attempts-per-student=100]
//       [--events-per-attempt=10] [--skills=10] [--warmup=3] [--runs=20] [--out=path]
import os from "node:os";
import { writeFileSync } from "node:fs";
import { withTestDb } from "../tests/helpers/database.js";
import type { Database } from "../packages/db/src/client.js";
import { searchEligibleQuestions } from "../apps/server/src/modules/question-bank/search.js";
import { LearningProfileService } from "../apps/server/src/modules/learning-profile/service.js";
import { ATTEMPT_SQL } from "../apps/server/src/modules/learning-profile/service.js";
import { AuthService } from "../apps/server/src/modules/auth/service.js";
import type { Actor } from "../packages/contracts/src/domain.js";

type Flags = {
  students: number;
  attemptsPerStudent: number;
  eventsPerAttempt: number;
  skills: number;
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
    "events-per-attempt",
    "skills",
    "warmup",
    "runs",
    "out",
  ]);
  for (const key of flags.keys())
    if (!known.has(key)) throw Error(`未知参数：--${key}`);
  return {
    students: positiveInt("students", flags.get("students"), 100),
    attemptsPerStudent: positiveInt(
      "attempts-per-student",
      flags.get("attempts-per-student"),
      100,
    ),
    eventsPerAttempt: positiveInt(
      "events-per-attempt",
      flags.get("events-per-attempt"),
      10,
    ),
    skills: positiveInt("skills", flags.get("skills"), 10),
    warmup: positiveInt("warmup", flags.get("warmup"), 3),
    runs: positiveInt("runs", flags.get("runs"), 20),
    out: flags.get("out") ?? null,
  };
}

const uuid = (prefix: string, expr: string) =>
  `('${prefix}-0000-4000-8000-' || lpad(to_hex(${expr})::text, 12, '0'))::uuid`;
const STUDENT_ID = uuid("00000000", "s");
const QUESTION_ID = uuid("10000000", "g");
const QUESTION_VERSION_ID = uuid("30000000", "g");
const ATTEMPT_ID = uuid("20000000", "g");
const TASK_ID = uuid("40000000", "s");
const EPISODE_ID = uuid("50000000", "g");
const SEGMENT_ID = uuid("60000000", "g");
const ENTRY_ID = uuid("70000000", "g");
const SKILL_ID = uuid("80000000", "k");
const EVENT_ID = uuid("90000000", "(g - 1) * $2 + j");
const GLOBAL_ROWS = `(
  SELECT s, k, (s - 1) * $2 + k AS g
  FROM generate_series(1, $1) s, generate_series(1, $2) k
) rows`;

async function seed(db: Database, flags: Flags) {
  const exec = async (sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows;
  const adminId = (
    await exec(
      `INSERT INTO users(login,password_hash,role)
       VALUES('bench-admin','x','admin') RETURNING id`,
    )
  )[0].id as string;

  const questionCount = flags.students * flags.attemptsPerStudent;
  await db.pool.query(
    `INSERT INTO student_profiles(id,display_name,timezone,preferences,created_at)
     SELECT ${STUDENT_ID}, 'bench-' || s, 'Asia/Shanghai', '{}'::jsonb,
            now() - interval '120 days'
     FROM generate_series(1, $1) s`,
    [flags.students],
  );
  await db.pool.query(
    `INSERT INTO skills(id,code,name,status,created_by)
     SELECT ${SKILL_ID}, 'skill-' || k, 'Skill ' || k, 'active', $2
     FROM generate_series(1, $1) k`,
    [flags.skills, adminId],
  );
  const batchId = (
    await exec(
      `INSERT INTO knowledge_batches(actor_id,text_content)
       VALUES($1,'bench') RETURNING id`,
      [adminId],
    )
  )[0].id as string;
  const parseRunId = (
    await exec(
      `INSERT INTO knowledge_parse_runs(batch_id,model,status,completed_at)
       VALUES($1,'bench','succeeded',now()) RETURNING id`,
      [batchId],
    )
  )[0].id as string;
  const itemId = (
    await exec(
      `INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status,published_at)
       VALUES($1,$2,'bench','bench','published',now()) RETURNING id`,
      [batchId, parseRunId],
    )
  )[0].id as string;
  await db.pool.query(
    `INSERT INTO skill_content_links(skill_id,knowledge_item_id,created_by)
     SELECT ${SKILL_ID}, $2, $3 FROM generate_series(1, $1) k`,
    [flags.skills, itemId, adminId],
  );

  await db.pool.query(
    `INSERT INTO questions(id,source_type)
     SELECT ${QUESTION_ID}, 'teacher' FROM generate_series(1, $1) g`,
    [questionCount],
  );
  await db.pool.query(
    `INSERT INTO question_versions(id,question_id,version_no,stem,reference_answer,verification)
     SELECT ${QUESTION_VERSION_ID}, ${QUESTION_ID}, 1, 'bench ' || g, '1', 'verified'
     FROM generate_series(1, $1) g`,
    [questionCount],
  );
  await db.pool.query(
    `INSERT INTO question_references(
       question_version_id,answer,answer_type,requires_working,verification,evidence)
     SELECT ${QUESTION_VERSION_ID}, '1', 'text', false, 'verified', '{}'::jsonb
     FROM generate_series(1, $1) g`,
    [questionCount],
  );
  await db.pool.query(
    `INSERT INTO question_bank_entries(
       id,question_version_id,difficulty_band,complexity_band,visibility,
       source_type,content_fingerprint,status,version,published_at,created_by,created_at)
     SELECT ${ENTRY_ID}, ${QUESTION_VERSION_ID},
            (ARRAY['easy','medium','challenge'])[(g % 3) + 1], 1 + (g % 3),
            'shared', 'teacher', 'fp-' || g, 'published', 1,
            now() - interval '120 days', $2, now() - interval '120 days'
     FROM generate_series(1, $1) g`,
    [questionCount, adminId],
  );
  await db.pool.query(
    `INSERT INTO question_skill_links(entry_id,skill_id,is_primary)
     SELECT ${ENTRY_ID},
            ('80000000-0000-4000-8000-'
              || lpad(to_hex(((g - 1) % $2) + 1)::text, 12, '0'))::uuid,
            true
     FROM generate_series(1, $1) g`,
    [questionCount, flags.skills],
  );
  await db.pool.query(
    `INSERT INTO learning_tasks(
       id,student_id,kind,title,status,created_at,updated_at)
     SELECT ${TASK_ID}, ${STUDENT_ID}, 'practice', 'bench', 'completed',
            now() - interval '120 days', now()
     FROM generate_series(1, $1) s`,
    [flags.students],
  );

  await db.pool.query(
    `INSERT INTO attempts(
       id,student_id,task_id,question_version_id,request_key,answer,created_at)
     SELECT ${ATTEMPT_ID}, ${STUDENT_ID}, ${TASK_ID}, ${QUESTION_VERSION_ID},
            'bench-' || k, '1', now() - make_interval(days => (g % 28))
     FROM ${GLOBAL_ROWS}`,
    [flags.students, flags.attemptsPerStudent],
  );
  await db.pool.query(
    `INSERT INTO assessments(
       attempt_id,correctness,verification,hint_dependency,method,
       verifier_version,evidence,created_at)
     SELECT id, 'correct', 'verified', 'none', 'model', 'v1', '{}'::jsonb, created_at
     FROM attempts`,
  );
  await db.pool.query(
    `INSERT INTO tutoring_episodes(
       id,student_id,task_id,question_version_id,request_key,state,teaching_state,
       lease_epoch,lease_expires_at,last_seq,exposure,prior_exposure,
       started_at,ended_at,first_submitted_at,created_at,updated_at)
     SELECT ${EPISODE_ID}, ${STUDENT_ID}, ${TASK_ID}, ${QUESTION_VERSION_ID},
            'ep-' || k, 'finished', 'awaiting_evidence', 1, now(), $3,
            'none', false,
            now() - interval '40 days', now() - interval '40 days',
            now() - interval '40 days', now() - interval '40 days',
            now() - interval '40 days'
     FROM ${GLOBAL_ROWS}`,
    [flags.students, flags.attemptsPerStudent, flags.eventsPerAttempt],
  );
  await db.pool.query(
    `INSERT INTO timing_segments(
       id,episode_id,phase,start_at,end_at,accepted_ms,quality,reason_codes,created_at)
     SELECT ${SEGMENT_ID}, ${EPISODE_ID}, 'initial',
            now() - interval '40 days', now() - interval '39 days',
            10000, 'reliable', '[]'::jsonb, now() - interval '40 days'
     FROM ${GLOBAL_ROWS}`,
    [flags.students, flags.attemptsPerStudent],
  );
  await db.pool.query(
    `INSERT INTO timing_events(
       episode_id,event_id,seq,segment_id,lease_epoch,kind,
       cumulative_active_ms,accepted_ms,phase,payload_hash,received_at,created_at)
     SELECT ${EPISODE_ID}, ${EVENT_ID}, j, ${SEGMENT_ID}, 1,
            CASE WHEN j = 1 THEN 'start'
                 WHEN j = $2 THEN 'finish'
                 ELSE 'checkpoint' END,
            j * 1000, 1000, 'initial', 'hash-' || g || '-' || j,
            now() - interval '40 days', now() - interval '40 days'
     FROM generate_series(1, $1) g, generate_series(1, $2) j`,
    [questionCount, flags.eventsPerAttempt],
  );
  await db.pool.query(
    `INSERT INTO attempt_timing_snapshots(
       attempt_id,episode_id,version,first_attempt_ms,total_active_ms,wall_ms,
       quality,reason_codes,first_submitted_at,evidence_boundary,created_at)
     SELECT a.id, e.id, 1, 10000, 10000, 10000, 'reliable', '[]'::jsonb,
            now() - interval '40 days', '{}'::jsonb, now() - interval '40 days'
     FROM attempts a
     JOIN tutoring_episodes e ON e.question_version_id = a.question_version_id`,
  );
  await db.pool.query(
    `INSERT INTO error_diagnoses(
       attempt_id,question_version_id,version,status,primary_code,summary,
       evidence,rule_version,created_by,created_at)
     SELECT id, question_version_id, 1, 'confirmed', 'execution_slip', 'bench',
            '[]'::jsonb, 'bench', $1, now() - interval '40 days'
     FROM attempts
     WHERE request_key IN ('bench-1','bench-2')`,
    [adminId],
  );

  await db.pool.query(
    `ANALYZE student_profiles, skills, knowledge_items, questions, question_versions,
       question_references, question_bank_entries, question_skill_links,
       learning_tasks, attempts, assessments, tutoring_episodes, timing_segments,
       timing_events, attempt_timing_snapshots, error_diagnoses`,
  );

  const counts = (
    await db.pool.query(
      `SELECT
         (SELECT count(*)::int FROM student_profiles) AS students,
         (SELECT count(*)::int FROM attempts) AS attempts,
         (SELECT count(*)::int FROM timing_events) AS "timingEvents",
         (SELECT count(*)::int FROM question_bank_entries) AS "bankEntries",
         (SELECT count(*)::int FROM error_diagnoses) AS diagnoses`,
    )
  ).rows[0];
  const sampleStudentId = (
    await db.pool.query(`SELECT id FROM student_profiles ORDER BY id LIMIT 1`)
  ).rows[0].id as string;
  const sampleSkillId = (
    await db.pool.query(`SELECT id FROM skills ORDER BY code LIMIT 1`)
  ).rows[0].id as string;
  return {
    counts: {
      students: Number(counts.students),
      attempts: Number(counts.attempts),
      timingEvents: Number(counts.timingEvents),
      bankEntries: Number(counts["bankEntries"]),
      diagnoses: Number(counts.diagnoses),
    },
    expected: {
      students: flags.students,
      attempts: questionCount,
      timingEvents: questionCount * flags.eventsPerAttempt,
      bankEntries: questionCount,
    },
    adminId,
    sampleStudentId,
    sampleSkillId,
  };
}

async function measure(
  run: () => Promise<unknown>,
  warmup: number,
  runs: number,
  onSample?: () => void,
) {
  for (let index = 0; index < warmup; index += 1) await run();
  const samples: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
    onSample?.();
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
  analyze = true,
) {
  const result = await pool.query(
    `EXPLAIN ${analyze ? "(ANALYZE, BUFFERS)" : ""} ${sql}`,
    params,
  );
  return {
    label,
    analyze,
    plan: result.rows.map((row) => row["QUERY PLAN"] as string).join("\n"),
  };
}

const CLEANUP_VICTIMS = `SELECT ev.id
  FROM timing_events ev
  JOIN tutoring_episodes e ON e.id = ev.episode_id
  WHERE ev.created_at < $1
    AND e.state = 'finished'
    AND EXISTS (
      SELECT 1 FROM attempt_timing_snapshots s
      WHERE s.episode_id = ev.episode_id
    )
  ORDER BY ev.created_at
  LIMIT $2`;
const LARGE_TABLES =
  /Seq Scan on (timing_events|attempts|question_bank_entries|question_skill_links|assessments|error_diagnoses)/;

const flags = parseArgs(process.argv.slice(2));
await withTestDb(async (db) => {
  const seedStarted = performance.now();
  const seeded = await seed(db, flags);
  const seedMs = round(performance.now() - seedStarted);
  for (const [key, expected] of Object.entries(seeded.expected)) {
    const actual = seeded.counts[key as keyof typeof seeded.counts];
    if (actual !== expected)
      throw Error(`造数校验失败：${key} 期望 ${expected}，实际 ${actual}`);
  }

  const actor: Actor = { userId: seeded.adminId, role: "admin" };
  const scope = { actor, studentId: seeded.sampleStudentId };
  const profiles = new LearningProfileService(db, new AuthService(db));
  let heapPeak = 0;
  const trackHeap = () => {
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
  };

  const candidateStats = await measure(
    () =>
      searchEligibleQuestions(db, scope, {
        skillId: seeded.sampleSkillId,
        goal: "diagnostic",
        limit: 10,
      }),
    flags.warmup,
    flags.runs,
    trackHeap,
  );
  const candidates = await searchEligibleQuestions(db, scope, {
    skillId: seeded.sampleSkillId,
    goal: "diagnostic",
    limit: 10,
  });

  const profileStats = await measure(
    () => profiles.rebuildSystem(seeded.sampleStudentId, seeded.sampleSkillId),
    flags.warmup,
    flags.runs,
    trackHeap,
  );

  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const cleanupCount = (
    await db.pool.query(
      `SELECT count(*)::int AS n FROM (${CLEANUP_VICTIMS}) victims`,
      [cutoff, 500],
    )
  ).rows[0].n as number;

  const plans = [];
  plans.push(
    await explain(
      db.pool,
      "candidate-search",
      `SELECT e.id, l.skill_id, e.difficulty_band,
         (SELECT count(*) FROM error_diagnoses d
          WHERE d.question_version_id = e.question_version_id
            AND d.status = 'confirmed' AND d.invalidated_at IS NULL
            AND EXISTS (SELECT 1 FROM attempts a
                        WHERE a.id = d.attempt_id AND a.student_id = $2::uuid)) AS matched,
         (SELECT count(*) FROM attempts a2
          WHERE a2.student_id = $2::uuid
            AND a2.question_version_id = e.question_version_id) AS seen
       FROM question_bank_entries e
       JOIN question_skill_links l ON l.entry_id = e.id AND l.is_primary
       WHERE e.status = 'published' AND l.skill_id = $1::uuid
         AND (e.visibility = 'shared' OR e.owner_id = $2::uuid)
         AND EXISTS (SELECT 1 FROM skill_content_links scl
                     JOIN knowledge_items ki ON ki.id = scl.knowledge_item_id
                     WHERE scl.skill_id = l.skill_id AND ki.status = 'published')
       ORDER BY seen, matched DESC, e.created_at, e.id
       LIMIT 10`,
      [seeded.sampleSkillId, seeded.sampleStudentId],
    ),
  );
  plans.push(
    await explain(db.pool, "profile-rebuild", ATTEMPT_SQL, [
      seeded.sampleStudentId,
      seeded.sampleSkillId,
    ]),
  );
  plans.push(
    await explain(db.pool, "timing-cleanup-victims", CLEANUP_VICTIMS, [
      cutoff,
      500,
    ]),
  );
  const victimIds = (
    await db.pool.query<{ id: string }>(CLEANUP_VICTIMS, [cutoff, 500])
  ).rows.map((row) => row.id);
  plans.push(
    await explain(
      db.pool,
      "timing-cleanup-delete",
      "DELETE FROM timing_events WHERE id = ANY($1::uuid[])",
      [victimIds],
      false,
    ),
  );

  const version = (
    await db.pool.query(
      `SELECT version() AS pg, current_setting('server_version') AS server`,
    )
  ).rows[0];
  const heapPeakMb = round(heapPeak / 1024 / 1024);
  const peakRssMb = round(process.resourceUsage().maxRSS / 1024);
  const scanPattern = new RegExp(LARGE_TABLES.source, "g");
  const planWarnings = plans
    .map((entry) => ({
      label: entry.label,
      scans: [...entry.plan.matchAll(scanPattern)].map((match) => match[1]!),
    }))
    .filter((entry) => entry.scans.length > 0);
  const target = "p95 < 1000ms";
  const passed =
    candidateStats.p95Ms < 1000 && profileStats.p95Ms < 1000;

  const report = {
    generatedAt: new Date().toISOString(),
    scope:
      "本机单实例结果，只代表此机器与数据集；不能当作 ECS（2 核 2GiB）容量保证。",
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
        eventsPerAttempt: flags.eventsPerAttempt,
        skills: flags.skills,
      },
      seedMs,
    },
    protocol: { warmup: flags.warmup, runs: flags.runs },
    results: [
      {
        name: "candidate-search",
        ...candidateStats,
        candidatesReturned: candidates.length,
      },
      { name: "profile-rebuild", ...profileStats },
    ],
    timingCleanupVictims: cleanupCount,
    memory: { heapPeakMb, peakRssMb },
    target,
    passed,
    planWarnings,
    plans,
  };
  const json = JSON.stringify(report, null, 2);
  if (flags.out) writeFileSync(flags.out, json + "\n");
  console.log(json);
});
