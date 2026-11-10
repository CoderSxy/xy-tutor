import type { PoolClient } from "pg";
import type { Actor } from "../../../../../packages/contracts/src/domain.js";
import type {
  AdminInsightScope,
  AttentionReason,
  DailyPoint,
  InsightCoverage,
  InsightFilter,
  InsightListDTO,
  InsightListQuery,
  InsightMeta,
  KnowledgeSummary,
  MaterialCoverage,
  MistakeCounts,
  Rate,
  StudentOverviewDTO,
  StudentOverviewResponse,
  StudentRowDTO,
} from "../../../../../packages/contracts/src/student-insights.js";
import {
  INSIGHT_TIMEZONE,
  METRIC_VERSION,
} from "../../../../../packages/contracts/src/student-insights.js";
import type { Database } from "../../../../../packages/db/src/client.js";
import {
  addDays,
  dayOf,
  dayStartUtc,
  inclusiveDays,
  rate,
  resolveInsightRange,
  shanghaiToday,
  streaks,
} from "./metrics.js";
import {
  LATEST_ASSESSMENT,
  VALID_ATTEMPT,
  readInsightFacts,
} from "./facts.js";

const EVENT_SOURCE_EXISTS = `CASE e.source_type
  WHEN 'attempt' THEN EXISTS(SELECT 1 FROM attempts x WHERE x.id = e.source_id)
  WHEN 'message' THEN EXISTS(SELECT 1 FROM messages x WHERE x.id = e.source_id)
  WHEN 'material' THEN EXISTS(SELECT 1 FROM materials x WHERE x.id = e.source_id)
  ELSE false
END`;

type ProfileRow = {
  studentId: string;
  displayName: string;
  createdAt: Date;
  logins: string[] | null;
};

type AttemptAggregate = {
  studentId: string;
  attempts: number;
  questions: number;
};

type FirstAttemptAggregate = {
  studentId: string;
  correct: number;
  verified: number;
  pending: number;
};

type TaskAggregate = {
  studentId: string;
  tasks: number;
  completed: number;
};

type MistakeAggregate = {
  studentId: string;
  pendingCorrections: number;
  pendingReviews: number;
  newMistakes: number;
};

type EventAggregate = {
  studentId: string;
  activeDays: number;
  lastLearningAt: Date | null;
};

type Evaluation = {
  attempts: number;
  questions: number;
  correct: number;
  verified: number;
  firstPending: number;
  tasks: number;
  completedTasks: number;
  pendingCorrections: number;
  pendingReviews: number;
  newMistakes: number;
  activeDays: number;
  lastLearningAt: Date | null;
};


type QueryWindow = {
  from: string;
  to: string;
  start: Date;
  endExclusive: Date;
  revisionId?: string;
};

type CoverageState = {
  visitsStartedAt: string | null;
  backfillVersion: string | null;
  learningComplete: boolean;
};

function metaFor(
  range: InsightFilter,
  now: Date,
  coverage: CoverageState,
): InsightMeta {
  return {
    from: range.from,
    to: range.to,
    timezone: INSIGHT_TIMEZONE,
    dataAsOf: now.toISOString(),
    metricVersion: METRIC_VERSION,
    coverage: {
      learning: coverage.learningComplete ? "complete" : "partial",
      historicalInferred: coverage.backfillVersion !== null,
      visitsStartedAt: coverage.visitsStartedAt,
      backfillVersion: coverage.backfillVersion,
    },
  };
}

async function readCoverage(
  tx: PoolClient,
  range: InsightFilter,
): Promise<CoverageState> {
  const state = await tx.query<{
    visitsStartedAt: Date;
    learningStartedAt: Date;
  }>(
    `SELECT visits_started_at AS "visitsStartedAt",
       learning_started_at AS "learningStartedAt"
     FROM student_insight_collection_state WHERE id = 1`,
  );
  const backfill = await tx.query<{
    version: string;
    fromDate: string;
    toDate: string;
  }>(
    `SELECT version, from_date AS "fromDate", to_date AS "toDate"
     FROM student_insight_backfills
     WHERE status = 'completed' AND from_date <= $1 AND to_date >= $2
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
    [range.from, range.to],
  );
  return {
    visitsStartedAt: state.rows[0]?.visitsStartedAt.toISOString() ?? null,
    backfillVersion: backfill.rows[0]?.version ?? null,
    learningComplete: backfill.rows.length > 0,
  };
}

function likePattern(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return `%${trimmed.replace(/[\\%_]/g, "\\$&")}%`;
}

async function readProfiles(
  tx: PoolClient,
  q: string | null,
): Promise<ProfileRow[]> {
  const result = await tx.query<ProfileRow>(
    `SELECT p.id AS "studentId", p.display_name AS "displayName",
       p.created_at AS "createdAt",
       (SELECT array_agg(u.login ORDER BY u.login)
        FROM student_access sa
        JOIN users u ON u.id = sa.user_id
        WHERE sa.student_id = p.id AND u.role = 'student') AS logins
     FROM student_profiles p
     WHERE $1::text IS NULL
       OR p.display_name ILIKE $1 ESCAPE '\\'
       OR EXISTS (
         SELECT 1 FROM student_access sa
         JOIN users u ON u.id = sa.user_id
         WHERE sa.student_id = p.id AND u.role = 'student'
           AND u.login ILIKE $1 ESCAPE '\\'
       )
     ORDER BY p.id`,
    [q],
  );
  return result.rows;
}

async function readAttemptAggregates(
  tx: PoolClient,
  range: QueryWindow,
): Promise<Map<string, AttemptAggregate>> {
  const result = await tx.query<AttemptAggregate>(
    `SELECT a.student_id AS "studentId",
       count(*)::int AS attempts,
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
    [range.start, range.endExclusive, range.revisionId ?? null],
  );
  return new Map(result.rows.map((row) => [row.studentId, row]));
}

async function readFirstAttemptAggregates(
  tx: PoolClient,
  range: QueryWindow,
): Promise<Map<string, FirstAttemptAggregate>> {
  const result = await tx.query<FirstAttemptAggregate>(
    `WITH firsts AS (
       SELECT DISTINCT ON (a.student_id, v.question_id)
         a.student_id AS "studentId", a.created_at AS "createdAt",
         q.revision_id AS "revisionId", s.correctness, s.verification
       FROM attempts a
       JOIN question_versions v ON v.id = a.question_version_id
       JOIN questions q ON q.id = v.question_id
       LEFT JOIN learning_tasks t ON t.id = a.task_id
       ${LATEST_ASSESSMENT}
       WHERE (a.task_id IS NULL OR t.deleted_at IS NULL)
         AND ${VALID_ATTEMPT}
       ORDER BY a.student_id, v.question_id, a.created_at, a.id
     )
     SELECT "studentId",
       count(*) FILTER (
         WHERE correctness = 'correct' AND verification = 'verified'
       )::int AS correct,
       count(*) FILTER (
         WHERE correctness IN ('correct','incorrect') AND verification = 'verified'
       )::int AS verified,
       count(*) FILTER (
         WHERE verification IS DISTINCT FROM 'verified'
           OR correctness NOT IN ('correct','incorrect')
       )::int AS pending
     FROM firsts
     WHERE "createdAt" >= $1 AND "createdAt" < $2
       AND ($3::uuid IS NULL OR "revisionId" = $3)
     GROUP BY "studentId"`,
    [range.start, range.endExclusive, range.revisionId ?? null],
  );
  return new Map(result.rows.map((row) => [row.studentId, row]));
}

async function readTaskAggregates(
  tx: PoolClient,
  range: QueryWindow,
): Promise<Map<string, TaskAggregate>> {
  const result = await tx.query<TaskAggregate>(
    `SELECT student_id AS "studentId",
       count(*)::int AS tasks,
       count(*) FILTER (WHERE status = 'completed')::int AS completed
     FROM learning_tasks
     WHERE deleted_at IS NULL
       AND created_at >= $1 AND created_at < $2
       AND ($3::uuid IS NULL OR revision_id = $3)
     GROUP BY student_id`,
    [range.start, range.endExclusive, range.revisionId ?? null],
  );
  return new Map(result.rows.map((row) => [row.studentId, row]));
}

async function readMistakeAggregates(
  tx: PoolClient,
  range: QueryWindow,
): Promise<Map<string, MistakeAggregate>> {
  const result = await tx.query<MistakeAggregate>(
    `SELECT m.student_id AS "studentId",
       count(*) FILTER (WHERE m.status = 'pending_correction')::int AS "pendingCorrections",
       count(*) FILTER (WHERE m.status = 'consolidated_pending_review')::int AS "pendingReviews",
       count(DISTINCT m.question_id) FILTER (
         WHERE m.created_at >= $1 AND m.created_at < $2
       )::int AS "newMistakes"
     FROM student_mistakes m
     JOIN questions q ON q.id = m.question_id
     WHERE ($3::uuid IS NULL OR q.revision_id = $3)
     GROUP BY m.student_id`,
    [range.start, range.endExclusive, range.revisionId ?? null],
  );
  return new Map(result.rows.map((row) => [row.studentId, row]));
}

async function readEventAggregates(
  tx: PoolClient,
  range: QueryWindow,
): Promise<Map<string, EventAggregate>> {
  const result = await tx.query<EventAggregate>(
    `SELECT e.student_id AS "studentId",
       count(DISTINCT (e.occurred_at AT TIME ZONE 'Asia/Shanghai')::date)
         FILTER (WHERE e.occurred_at >= $1 AND e.occurred_at < $2)::int AS "activeDays",
       max(e.occurred_at) AS "lastLearningAt"
     FROM student_learning_events e
     LEFT JOIN learning_tasks t ON t.id = e.task_id
     WHERE (e.task_id IS NULL OR t.deleted_at IS NULL)
       AND ($3::uuid IS NULL OR e.revision_id = $3)
       AND ${EVENT_SOURCE_EXISTS}
     GROUP BY e.student_id`,
    [range.start, range.endExclusive, range.revisionId ?? null],
  );
  return new Map(result.rows.map((row) => [row.studentId, row]));
}

function inactiveCutoff(today: string): Date {
  // 最近 7 个自然日 = [today-6, today]；该范围之前最后学习即视为不活跃
  return dayStartUtc(addDays(today, -6));
}

function attentionReasons(input: {
  createdAt: Date;
  now: Date;
  lastLearningAt: Date | null;
  pendingCorrections: number;
  cutoff: Date;
}): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  const established = input.createdAt.getTime() <= input.now.getTime() - 7 * 86_400_000;
  const recent =
    input.lastLearningAt !== null && input.lastLearningAt >= input.cutoff;
  if (established && !recent)
    reasons.push({
      type: "inactive_7d",
      label: "已满 7 天未学习",
      value: 7,
    });
  if (input.pendingCorrections >= 10)
    reasons.push({
      type: "pending_corrections_10",
      label: "待订正达到 10 题",
      value: input.pendingCorrections,
    });
  return reasons;
}

function compareRows(
  a: StudentRowDTO,
  b: StudentRowDTO,
  sort: InsightListQuery["sort"],
): number {
  const tie = a.studentId.localeCompare(b.studentId);
  if (sort === "active_days")
    return b.activeDays - a.activeDays || tie;
  if (sort === "first_attempt_accuracy") {
    const av = a.firstAttemptAccuracy.value;
    const bv = b.firstAttemptAccuracy.value;
    if (av === null && bv === null) return tie;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av || tie;
  }
  const at = a.lastLearningAt ? Date.parse(a.lastLearningAt) : null;
  const bt = b.lastLearningAt ? Date.parse(b.lastLearningAt) : null;
  if (at === null && bt === null) return tie;
  if (at === null) return 1;
  if (bt === null) return -1;
  return bt - at || tie;
}

function toRate(correct: number, verified: number): Rate {
  return rate(correct, verified);
}

export class InsightQueryService {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(
    _actor: Actor,
    input: InsightListQuery,
  ): Promise<InsightListDTO> {
    const now = this.now();
    const range = resolveInsightRange(input, now);
    const filter: QueryWindow = {
      ...range,
      revisionId: input.revisionId,
    };
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const [profiles, attempts, firsts, tasks, mistakes, events, coverage] =
        await Promise.all([
          readProfiles(client, likePattern(input.q)),
          readAttemptAggregates(client, filter),
          readFirstAttemptAggregates(client, filter),
          readTaskAggregates(client, filter),
          readMistakeAggregates(client, filter),
          readEventAggregates(client, filter),
          readCoverage(client, filter),
        ]);

      const today = shanghaiToday(now);
      const cutoff = inactiveCutoff(today);
      const evaluations = new Map<string, Evaluation>();
      for (const profile of profiles) {
        const attempt = attempts.get(profile.studentId);
        const first = firsts.get(profile.studentId);
        const task = tasks.get(profile.studentId);
        const mistake = mistakes.get(profile.studentId);
        const event = events.get(profile.studentId);
        evaluations.set(profile.studentId, {
          attempts: attempt?.attempts ?? 0,
          questions: attempt?.questions ?? 0,
          correct: first?.correct ?? 0,
          verified: first?.verified ?? 0,
          firstPending: first?.pending ?? 0,
          tasks: task?.tasks ?? 0,
          completedTasks: task?.completed ?? 0,
          pendingCorrections: mistake?.pendingCorrections ?? 0,
          pendingReviews: mistake?.pendingReviews ?? 0,
          newMistakes: mistake?.newMistakes ?? 0,
          activeDays: event?.activeDays ?? 0,
          lastLearningAt: event?.lastLearningAt ?? null,
        });
      }

      const rows: StudentRowDTO[] = [];
      for (const profile of profiles) {
        const evaluation = evaluations.get(profile.studentId)!;
        const reasons = attentionReasons({
          createdAt: profile.createdAt,
          now,
          lastLearningAt: evaluation.lastLearningAt,
          pendingCorrections: evaluation.pendingCorrections,
          cutoff,
        });
        if (input.attention !== "any")
          if (!reasons.some((reason) => reason.type === input.attention))
            continue;
        rows.push({
          studentId: profile.studentId,
          displayName: profile.displayName,
          studentLogins: profile.logins ?? [],
          lastLearningAt: evaluation.lastLearningAt?.toISOString() ?? null,
          activeDays: evaluation.activeDays,
          attempts: evaluation.attempts,
          questions: evaluation.questions,
          firstAttemptAccuracy: toRate(
            evaluation.correct,
            evaluation.verified,
          ),
          pendingCorrections: evaluation.pendingCorrections,
          pendingReviews: evaluation.pendingReviews,
          taskCompletion: toRate(
            evaluation.completedTasks,
            evaluation.tasks,
          ),
          attentionReasons: reasons,
        });
      }

      rows.sort((a, b) => compareRows(a, b, input.sort));
      const summary = {
        students: rows.length,
        activeStudents: rows.filter((row) => row.activeDays > 0).length,
        attempts: rows.reduce((total, row) => total + row.attempts, 0),
        newMistakes: rows.reduce(
          (total, row) =>
            total +
            (evaluations.get(row.studentId)?.newMistakes ?? 0),
          0,
        ),
      };
      const items = rows.slice(input.offset, input.offset + input.limit);
      await client.query("COMMIT");

      return {
        items,
        total: rows.length,
        summary,
        meta: metaFor(filter, now, coverage),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async overview(
    scope: AdminInsightScope,
    filter: InsightFilter,
  ): Promise<StudentOverviewResponse> {
    const now = this.now();
    const range = resolveInsightRange(filter, now);
    const normalized: QueryWindow = {
      ...range,
      revisionId: filter.revisionId,
    };
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const [profile, facts, currentMistakes, knowledge, materialRows, lastLearningAt, coverage] =
        await Promise.all([
          client.query<{ displayName: string }>(
            `SELECT display_name AS "displayName"
             FROM student_profiles WHERE id = $1`,
            [scope.studentId],
          ),
          readInsightFacts(client, scope.studentId, normalized),
          client.query<{ status: string }>(
            `SELECT m.status
             FROM student_mistakes m
             JOIN questions q ON q.id = m.question_id
             WHERE m.student_id = $1
               AND ($2::uuid IS NULL OR q.revision_id = $2)`,
            [scope.studentId, normalized.revisionId ?? null],
          ),
          client.query<{
            knowledgePoint: string;
            attempts: number;
            verified: number;
            correct: number;
            hintDependency: string;
          }>(
            `SELECT COALESCE(v.knowledge_point, '未标注') AS "knowledgePoint",
               count(*)::int AS attempts,
               count(*) FILTER (WHERE s.verification = 'verified')::int AS verified,
               count(*) FILTER (
                 WHERE s.verification = 'verified' AND s.correctness = 'correct'
               )::int AS correct,
               COALESCE(s.hint_dependency, 'none') AS "hintDependency"
             FROM attempts a
             JOIN question_versions v ON v.id = a.question_version_id
             JOIN questions q ON q.id = v.question_id
             LEFT JOIN learning_tasks t ON t.id = a.task_id
             ${LATEST_ASSESSMENT}
             WHERE a.student_id = $1
               AND a.created_at >= $2 AND a.created_at < $3
               AND (a.task_id IS NULL OR t.deleted_at IS NULL)
               AND ($4::uuid IS NULL OR q.revision_id = $4)
               AND ${VALID_ATTEMPT}
             GROUP BY 1, "hintDependency"
             ORDER BY 1`,
            [
              scope.studentId,
              range.start,
              range.endExclusive,
              normalized.revisionId ?? null,
            ],
          ),
          client.query<{
            materialId: string;
            name: string;
            contentType: string;
            type: string;
            status: string;
            questionId: string | null;
          }>(
            `SELECT m.id AS "materialId", f.name, f.content_type AS "contentType",
               m.type, m.status, v.question_id AS "questionId"
             FROM materials m
             JOIN files f ON f.id = m.file_id
             LEFT JOIN extractions e ON e.material_id = m.id
             LEFT JOIN question_sources src ON src.extraction_id = e.id
             LEFT JOIN question_versions v ON v.id = src.question_version_id
             WHERE m.student_id = $1
               AND m.created_at >= $2 AND m.created_at < $3
               AND ($4::uuid IS NULL OR m.revision_id = $4)
             ORDER BY m.created_at, m.id, src.question_version_id`,
            [
              scope.studentId,
              range.start,
              range.endExclusive,
              normalized.revisionId ?? null,
            ],
          ),
          readLastLearningAt(
            client,
            scope.studentId,
            normalized.revisionId ?? null,
          ),
          readCoverage(client, normalized),
        ]);

      const correct = facts.firstAttempts.filter(
        (row) =>
          row.assessment?.verification === "verified" &&
          row.assessment.correctness === "correct",
      ).length;
      const verified = facts.firstAttempts.filter(
        (row) =>
          row.assessment?.verification === "verified" &&
          ["correct", "incorrect"].includes(row.assessment.correctness),
      ).length;
      const firstPending = facts.firstAttempts.filter(
        (row) =>
          !row.assessment ||
          row.assessment.verification !== "verified" ||
          !["correct", "incorrect"].includes(row.assessment.correctness),
      ).length;

      const statuses: MistakeCounts = {
        pending_correction: 0,
        correcting: 0,
        corrected_pending_practice: 0,
        consolidated_pending_review: 0,
        mastered: 0,
      };
      for (const row of currentMistakes.rows)
        if (row.status in statuses)
          statuses[row.status as keyof MistakeCounts] += 1;

      const daily = buildDaily(facts);
      const eventDays = facts.events.map((event) => dayOf(event.occurredAt));
      const activeDays = new Set(eventDays).size;
      const streak = streaks(eventDays, shanghaiToday(now));
      const knowledgeSummary = mergeKnowledge(knowledge.rows);
      const materials = materialCoverage(materialRows.rows, facts.attempts);
      const newMistakes = new Set(
        facts.mistakes
          .filter(
            (row) =>
              row.createdAt >= range.start && row.createdAt < range.endExclusive,
          )
          .map((row) => row.questionId),
      ).size;
      const completedTasks = facts.tasks.filter(
        (task) => task.status === "completed",
      ).length;

      const overview: StudentOverviewDTO = {
        studentId: scope.studentId,
        displayName: profile.rows[0]!.displayName,
        counts: {
          attempts: facts.attempts.length,
          questions: new Set(facts.attempts.map((row) => row.questionId)).size,
          newMistakes,
          tasks: facts.tasks.length,
          completedTasks,
          activeDays,
          currentStreak: streak.current,
          longestStreak: streak.longest,
          firstAttemptPending: firstPending,
          mistakes: statuses,
        },
        firstAttemptAccuracy: toRate(correct, verified),
        taskCompletion: toRate(completedTasks, facts.tasks.length),
        daily,
        knowledge: knowledgeSummary,
        materials,
        lastLearningAt: lastLearningAt?.toISOString() ?? null,
      };
      await client.query("COMMIT");
      return { overview, meta: metaFor(normalized, now, coverage) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function buildDaily(
  facts: Awaited<ReturnType<typeof readInsightFacts>>,
): DailyPoint[] {
  const counts = new Map<
    string,
    { attempts: number; questions: Set<string>; correct: number; verified: number }
  >();
  const point = (date: string) => {
    const existing = counts.get(date);
    if (existing) return existing;
    const created = {
      attempts: 0,
      questions: new Set<string>(),
      correct: 0,
      verified: 0,
    };
    counts.set(date, created);
    return created;
  };
  for (const attempt of facts.attempts) {
    const bucket = point(dayOf(attempt.createdAt));
    bucket.attempts += 1;
    bucket.questions.add(attempt.questionId);
  }
  for (const first of facts.firstAttempts) {
    if (
      first.assessment?.verification !== "verified" ||
      !["correct", "incorrect"].includes(first.assessment.correctness)
    )
      continue;
    const bucket = point(dayOf(first.createdAt));
    bucket.verified += 1;
    if (first.assessment.correctness === "correct") bucket.correct += 1;
  }
  return inclusiveDays(facts.range.from, facts.range.to).map((date) => {
    const bucket = counts.get(date);
    return {
      date,
      attempts: bucket?.attempts ?? 0,
      questions: bucket?.questions.size ?? 0,
      firstAttempts: toRate(bucket?.correct ?? 0, bucket?.verified ?? 0),
    };
  });
}

function mergeKnowledge(
  rows: {
    knowledgePoint: string;
    attempts: number;
    verified: number;
    correct: number;
    hintDependency: string;
  }[],
): KnowledgeSummary[] {
  const merged = new Map<string, KnowledgeSummary>();
  for (const row of rows) {
    const summary =
      merged.get(row.knowledgePoint) ??
      {
        knowledgePoint: row.knowledgePoint,
        attempts: 0,
        verified: 0,
        correct: 0,
        hintDependency: {},
      };
    summary.attempts += row.attempts;
    summary.verified += row.verified;
    summary.correct += row.correct;
    summary.hintDependency[row.hintDependency] =
      (summary.hintDependency[row.hintDependency] ?? 0) + row.attempts;
    merged.set(row.knowledgePoint, summary);
  }
  return [...merged.values()].sort((a, b) =>
    a.knowledgePoint.localeCompare(b.knowledgePoint),
  );
}

function materialCoverage(
  rows: {
    materialId: string;
    name: string;
    contentType: string;
    type: string;
    status: string;
    questionId: string | null;
  }[],
  attempts: Awaited<ReturnType<typeof readInsightFacts>>["attempts"],
): MaterialCoverage[] {
  const answered = new Set(attempts.map((row) => row.questionId));
  const verified = new Set(
    attempts
      .filter(
        (row) =>
          row.assessment?.verification === "verified" &&
          ["correct", "incorrect"].includes(row.assessment.correctness),
      )
      .map((row) => row.questionId),
  );
  const materialQuestions = new Map<string, Set<string>>();
  const materials = new Map<
    string,
    {
      materialId: string;
      name: string;
      type: string;
      status: string;
    }
  >();
  for (const row of rows) {
    if (!materials.has(row.materialId))
      materials.set(row.materialId, {
        materialId: row.materialId,
        name: row.name,
        type: row.type,
        status: row.status,
      });
    const questions =
      materialQuestions.get(row.materialId) ?? new Set<string>();
    if (row.questionId) questions.add(row.questionId);
    materialQuestions.set(row.materialId, questions);
  }
  return [...materials.values()].map((material) => {
    const questions = materialQuestions.get(material.materialId) ?? new Set();
    return {
      materialId: material.materialId,
      name: material.name,
      type: material.type,
      status: material.status,
      totalQuestions: questions.size,
      answeredQuestions: [...questions].filter((id) => answered.has(id)).length,
      verifiedQuestions: [...questions].filter((id) => verified.has(id)).length,
    };
  });
}

async function readLastLearningAt(
  tx: PoolClient,
  studentId: string,
  revisionId: string | null,
): Promise<Date | null> {
  const result = await tx.query<{ lastLearningAt: Date | null }>(
    `SELECT max(e.occurred_at) AS "lastLearningAt"
     FROM student_learning_events e
     LEFT JOIN learning_tasks t ON t.id = e.task_id
     WHERE e.student_id = $1
       AND (e.task_id IS NULL OR t.deleted_at IS NULL)
       AND ($2::uuid IS NULL OR e.revision_id = $2)
       AND ${EVENT_SOURCE_EXISTS}`,
    [studentId, revisionId],
  );
  return result.rows[0]?.lastLearningAt ?? null;
}

export type { InsightCoverage };
