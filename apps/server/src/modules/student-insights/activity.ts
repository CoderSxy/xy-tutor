import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Actor } from "../../../../../packages/contracts/src/domain.js";
import type {
  ActivityDTO,
  ActivityDay,
  AdminInsightScope,
  InsightFilter,
} from "../../../../../packages/contracts/src/student-insights.js";
import { INSIGHT_TIMEZONE } from "../../../../../packages/contracts/src/student-insights.js";
import type { Database } from "../../../../../packages/db/src/client.js";
import { requireSession } from "../auth/routes.js";
import {
  dayOf,
  inclusiveDays,
  resolveInsightRange,
  shanghaiToday,
  streaks,
} from "./metrics.js";
import { metaFor, readCoverage, type CoverageState } from "./queries.js";

export {
  backfillStudentInsights,
  type BackfillOptions,
  type BackfillResult,
} from "./backfill.js";

export type LearningEventType =
  | "answer_submitted"
  | "learning_message_sent"
  | "material_submitted";

export type LearningEventSourceType = "attempt" | "message" | "material";

export type LearningEventInput = {
  studentId: string;
  actorId: string;
  eventType: LearningEventType;
  sourceType: LearningEventSourceType;
  sourceId: string;
  taskId?: string | null;
  revisionId?: string | null;
  occurredAt: Date;
  sourceOrigin: "live" | "historical_inferred";
};

// 只采集学生本人（owner）的提交事实：管理员、viewer 及非学生角色一律不记。
const OWNER_ACTOR = `EXISTS (
  SELECT 1 FROM student_access sa
  JOIN users u ON u.id = sa.user_id
  WHERE sa.student_id = $1 AND sa.user_id = $2
    AND sa.permission = 'owner' AND u.role = 'student'
)`;

export async function recordLearningEvent(
  tx: PoolClient,
  input: LearningEventInput,
): Promise<void> {
  const owner = await tx.query(OWNER_ACTOR, [input.studentId, input.actorId]);
  if (!owner.rowCount) return;
  await tx.query(
    `INSERT INTO student_learning_events(
       student_id, actor_id, event_type, source_type, source_id,
       task_id, revision_id, occurred_at, source_origin
     )
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
     WHERE NOT EXISTS (
       SELECT 1 FROM student_learning_events
       WHERE student_id = $1 AND event_type = $3
         AND source_type = $4 AND source_id = $5
     )`,
    [
      input.studentId,
      input.actorId,
      input.eventType,
      input.sourceType,
      input.sourceId,
      input.taskId ?? null,
      input.revisionId ?? null,
      input.occurredAt,
      input.sourceOrigin,
    ],
  );
}

export async function recordStudentVisit(
  db: Database,
  actor: Actor,
  now: Date,
): Promise<void> {
  if (actor.role !== "student") return;
  await db.pool.query(
    `INSERT INTO student_daily_visits(
       student_id, local_date, timezone, first_seen_at, last_seen_at
     )
     SELECT sa.student_id, $2::date, $3, $1, $1
     FROM student_access sa
     JOIN users u ON u.id = sa.user_id
     JOIN student_insight_collection_state st ON st.id = 1
     WHERE sa.user_id = $4 AND sa.permission = 'owner' AND u.role = 'student'
       AND $1 >= st.visits_started_at
     ON CONFLICT (student_id, local_date, timezone)
     DO UPDATE SET last_seen_at =
       GREATEST(student_daily_visits.last_seen_at, EXCLUDED.last_seen_at)`,
    [now, shanghaiToday(now), INSIGHT_TIMEZONE, actor.userId],
  );
}

export async function initializeInsightCollection(
  db: Database,
  now: Date = new Date(),
): Promise<void> {
  await db.pool.query(
    `INSERT INTO student_insight_collection_state(
       id, learning_started_at, visits_started_at
     ) VALUES (1, $1, $1)
     ON CONFLICT (id) DO NOTHING`,
    [now],
  );
}

// 访问只由当前会话本人产生，请求体不得携带学生或时间信息。
const emptyVisitBody = z.object({}).strict();

export function registerStudentVisits(
  app: FastifyInstance,
  deps: { database: Database },
): void {
  app.post("/api/student-visits", async (request) => {
    const actor = requireSession(request).actor;
    emptyVisitBody.parse(request.body ?? {});
    await recordStudentVisit(deps.database, actor, new Date());
    return { ok: true };
  });
}

type DayCount = { day: string; count: number };

export class InsightActivityService {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(
    scope: AdminInsightScope,
    filter: Partial<InsightFilter>,
  ): Promise<ActivityDTO> {
    const now = this.now();
    const range = resolveInsightRange(filter, now);
    const client = await this.database.pool.connect();
    let events: DayCount[];
    let visits: DayCount[];
    let coverage: CoverageState;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      events = (
        await client.query<DayCount>(
          `SELECT to_char(
             timezone($4, e.occurred_at), 'YYYY-MM-DD'
           ) AS day, count(*)::int AS count
           FROM student_learning_events e
           LEFT JOIN learning_tasks t ON t.id = e.task_id
           WHERE e.student_id = $1
             AND e.occurred_at >= $2 AND e.occurred_at < $3
             AND (e.task_id IS NULL OR t.deleted_at IS NULL)
           GROUP BY 1`,
          [scope.studentId, range.start, range.endExclusive, INSIGHT_TIMEZONE],
        )
      ).rows;
      visits = (
        await client.query<DayCount>(
          `SELECT to_char(local_date, 'YYYY-MM-DD') AS day, count(*)::int AS count
           FROM student_daily_visits
           WHERE student_id = $1 AND local_date >= $2::date
             AND local_date <= $3::date
           GROUP BY 1`,
          [scope.studentId, range.from, range.to],
        )
      ).rows;
      coverage = await readCoverage(client, {
        from: range.from,
        to: range.to,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const eventCounts = new Map(
      events.map((row) => [row.day, Number(row.count)]),
    );
    const visitCounts = new Map(
      visits.map((row) => [row.day, Number(row.count)]),
    );
    const visitsStartedDay = coverage.visitsStartedAt
      ? dayOf(new Date(coverage.visitsStartedAt))
      : null;
    const days: ActivityDay[] = inclusiveDays(range.from, range.to).map((date) => {
      const eventsOnDay = eventCounts.get(date) ?? 0;
      const collected = visitsStartedDay !== null && date >= visitsStartedDay;
      return {
        date,
        events: eventsOnDay,
        active: eventsOnDay > 0,
        visits: collected ? (visitCounts.get(date) ?? 0) : null,
      };
    });
    const activeDays = days.filter((day) => day.active).map((day) => day.date);
    const visitedDays = days.filter((day) => (day.visits ?? 0) > 0).length;
    const { current, longest } = streaks(activeDays, shanghaiToday(now));
    return {
      days,
      activeDays: activeDays.length,
      currentStreak: current,
      longestStreak: longest,
      visitedDays,
      meta: metaFor(
        { from: range.from, to: range.to, revisionId: filter.revisionId },
        now,
        coverage,
      ),
    };
  }
}
