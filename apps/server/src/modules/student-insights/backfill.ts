import type { PoolClient } from "pg";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { Database } from "../../../../../packages/db/src/client.js";
import { inTransaction } from "../../../../../packages/db/src/client.js";
import { addDays, dayNumber, dayOf, dayStartUtc, parseDay } from "./metrics.js";

export type BackfillOptions = {
  from: string;
  to: string;
  batchSize?: number;
  dryRun?: boolean;
  resume?: boolean;
};

export type BackfillResult = {
  scanned: number;
  inserted: number;
  coverageStatus: "partial" | "complete";
};

type SourceKind = "attempt" | "message" | "material";

type SourceCursor = { createdAt: string; id: string };
type Cursors = Partial<Record<SourceKind, SourceCursor>>;

type SourceRow = {
  id: string;
  createdAt: Date;
  studentId: string;
  taskId: string | null;
  revisionId: string | null;
};

type Source = {
  kind: SourceKind;
  eventType:
    "answer_submitted" | "learning_message_sent" | "material_submitted";
  sql: string;
};

const CURSOR = `($4::timestamptz IS NULL OR (s.created_at, s.id) > ($4::timestamptz, $5::uuid))`;

const SOURCES: Source[] = [
  {
    kind: "attempt",
    eventType: "answer_submitted",
    sql: `SELECT s.id, s.created_at AS "createdAt", s.student_id AS "studentId",
        s.task_id AS "taskId", t.revision_id AS "revisionId"
      FROM attempts s
      JOIN learning_tasks t ON t.id = s.task_id
      WHERE s.created_at >= $1 AND s.created_at < $2
        AND t.deleted_at IS NULL AND ${CURSOR}
      ORDER BY s.created_at, s.id
      LIMIT $3`,
  },
  {
    kind: "message",
    eventType: "learning_message_sent",
    sql: `SELECT s.id, s.created_at AS "createdAt", c.student_id AS "studentId",
        c.task_id AS "taskId", c.revision_id AS "revisionId"
      FROM messages s
      JOIN conversations c ON c.id = s.conversation_id
      LEFT JOIN learning_tasks t ON t.id = c.task_id
      WHERE s.role = 'user' AND s.created_at >= $1 AND s.created_at < $2
        AND (c.task_id IS NULL OR t.deleted_at IS NULL) AND ${CURSOR}
      ORDER BY s.created_at, s.id
      LIMIT $3`,
  },
  {
    kind: "material",
    eventType: "material_submitted",
    sql: `SELECT s.id, s.created_at AS "createdAt", s.student_id AS "studentId",
        NULL::uuid AS "taskId", s.revision_id AS "revisionId"
      FROM materials s
      WHERE s.created_at >= $1 AND s.created_at < $2 AND ${CURSOR}
      ORDER BY s.created_at, s.id
      LIMIT $3`,
  },
];

const INSERT_EVENT = `INSERT INTO student_learning_events(
  student_id, actor_id, event_type, source_type, source_id,
  task_id, revision_id, occurred_at, source_origin
) VALUES($1, NULL, $2, $3, $4, $5, $6, $7, 'historical_inferred')
ON CONFLICT (student_id, event_type, source_type, source_id) DO NOTHING`;

function clampBatchSize(value: number | undefined): number {
  if (value === undefined) return 500;
  if (!Number.isFinite(value)) return 500;
  return Math.min(Math.max(Math.floor(value), 1), 5000);
}

function cursorFor(cursors: Cursors, kind: SourceKind): SourceCursor | null {
  return cursors[kind] ?? null;
}

async function countMissing(
  client: PoolClient,
  source: Source,
  ids: string[],
): Promise<number> {
  const found = await client.query<{ sourceId: string }>(
    `SELECT source_id AS "sourceId" FROM student_learning_events
     WHERE source_type = $1 AND source_id = ANY($2::uuid[])`,
    [source.kind, ids],
  );
  return ids.length - found.rows.length;
}

async function writeBatch(
  db: Database,
  version: string,
  source: Source,
  rows: SourceRow[],
  cursor: SourceCursor,
): Promise<number> {
  return inTransaction(db, async (tx) => {
    let inserted = 0;
    for (const row of rows) {
      const result = await tx.query(INSERT_EVENT, [
        row.studentId,
        source.eventType,
        source.kind,
        row.id,
        row.taskId,
        row.revisionId,
        row.createdAt,
      ]);
      inserted += result.rowCount ?? 0;
    }
    await tx.query(
      `UPDATE student_insight_backfills
       SET last_source_cursor = COALESCE(last_source_cursor, '{}'::jsonb)
         || jsonb_build_object($2::text,
              jsonb_build_object('createdAt', $3::text, 'id', $4::text)),
           status = 'partial',
           updated_at = now()
       WHERE version = $1`,
      [version, source.kind, cursor.createdAt, cursor.id],
    );
    return inserted;
  });
}

export async function backfillStudentInsights(
  db: Database,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const { from, to } = options;
  const batchSize = clampBatchSize(options.batchSize);
  const dryRun = options.dryRun ?? false;
  const resume = options.resume ?? true;
  parseDay(from);
  parseDay(to);
  if (from > to)
    throw new AppError("VALIDATION", 422, "开始日期不能晚于结束日期");
  if (dayNumber(to) - dayNumber(from) + 1 > 366)
    throw new AppError("VALIDATION", 422, "回填范围不能超过366天");

  const version = `student-insights-backfill-v2:${from}:${to}`;
  const lockClient = await db.pool.connect();
  let locked = false;
  try {
    const lock = await lockClient.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS ok",
      ["student_insight_backfill", version],
    );
    locked = lock.rows[0]?.ok === true;
    if (!locked) throw new Error("已有回填任务正在执行");

    const state = await lockClient.query<{ learningStartedAt: Date }>(
      `SELECT learning_started_at AS "learningStartedAt"
       FROM student_insight_collection_state WHERE id = 1`,
    );
    if (!state.rowCount) throw new Error("采集状态未初始化");
    const hardEnd = state.rows[0]!.learningStartedAt;

    // 硬截断：用户传入的 to 不能越过采集上线时刻。
    const fromStart = dayStartUtc(from);
    const userEnd = dayStartUtc(addDays(to, 1));
    const endExclusive =
      userEnd.getTime() < hardEnd.getTime() ? userEnd : hardEnd;
    const cutoffDay = dayOf(new Date(endExclusive.getTime() - 1));
    // Scan to the actual switch instant, including its partial calendar day.
    // The remaining part of that day is covered by live collection.
    const effectiveTo = cutoffDay;
    if (endExclusive <= fromStart)
      throw new AppError("VALIDATION", 422, "没有可回填的历史记录范围");
    const scanEnd = endExclusive;

    const existing = await lockClient.query<{
      status: string;
      cursor: Cursors | null;
    }>(
      `SELECT status, last_source_cursor AS cursor
       FROM student_insight_backfills WHERE version = $1`,
      [version],
    );
    if (!dryRun && existing.rows[0]?.status === "completed")
      return { scanned: 0, inserted: 0, coverageStatus: "complete" };

    if (!dryRun)
      await lockClient.query(
        `INSERT INTO student_insight_backfills(
           version, from_date, to_date, last_source_cursor, status
         ) VALUES($1, $2, $3, NULL, 'partial')
         ON CONFLICT (version) DO UPDATE
         SET from_date = EXCLUDED.from_date, to_date = EXCLUDED.to_date,
           status = 'partial', updated_at = now()`,
        [version, from, effectiveTo],
      );

    const cursors: Cursors = resume ? (existing.rows[0]?.cursor ?? {}) : {};
    let scanned = 0;
    let inserted = 0;
    for (const source of SOURCES) {
      let cursor = cursorFor(cursors, source.kind);
      for (;;) {
        const rows = (
          await lockClient.query<SourceRow>(source.sql, [
            fromStart,
            scanEnd,
            batchSize,
            cursor?.createdAt ?? null,
            cursor?.id ?? null,
          ])
        ).rows;
        if (!rows.length) break;
        scanned += rows.length;
        const last = rows[rows.length - 1]!;
        const nextCursor: SourceCursor = {
          createdAt: last.createdAt.toISOString(),
          id: last.id,
        };
        if (dryRun)
          inserted += await countMissing(
            lockClient,
            source,
            rows.map((row) => row.id),
          );
        else
          inserted += await writeBatch(db, version, source, rows, nextCursor);
        cursor = nextCursor;
        if (rows.length < batchSize) break;
      }
    }

    if (!dryRun)
      await lockClient.query(
        `UPDATE student_insight_backfills
         SET status = 'completed', updated_at = now() WHERE version = $1`,
        [version],
      );
    return { scanned, inserted, coverageStatus: "complete" };
  } catch (error) {
    if (!dryRun)
      await lockClient
        .query(
          `UPDATE student_insight_backfills
           SET status = 'partial', updated_at = now()
           WHERE version = $1 AND status <> 'completed'`,
          [version],
        )
        .catch(() => undefined);
    throw error;
  } finally {
    if (locked)
      await lockClient
        .query("SELECT pg_advisory_unlock(hashtext($1), hashtext($2))", [
          "student_insight_backfill",
          version,
        ])
        .catch(() => undefined);
    lockClient.release();
  }
}
