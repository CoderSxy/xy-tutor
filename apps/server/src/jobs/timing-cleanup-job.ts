import type { Database } from "../../../../packages/db/src/client.js";
import type { JobHandler } from "./runner.js";
import type { JobQueue } from "./queue.js";

export const TIMING_RETENTION_DAYS = 30;
export const TIMING_CLEANUP_BATCH_SIZE = 500;
export const TIMING_CLEANUP_JOB_KIND = "learning_timing.cleanup";

export type TimingCleanupResult = {
  deleted: number;
  batches: number;
};

/**
 * Deletes raw timing events that are no longer needed: timing is sealed
 * (teaching may remain paused for further correction),
 * an attempt timing snapshot already froze the aggregate, and the event is
 * older than the retention window. Segments, snapshots, diagnoses and frozen
 * metrics are never touched, so historical reports stay reproducible.
 */
export async function cleanupSealedTimingEvents(
  db: Database,
  now = new Date(),
): Promise<TimingCleanupResult> {
  const cutoff = new Date(now.getTime() - TIMING_RETENTION_DAYS * 86_400_000);
  let deleted = 0;
  let batches = 0;
  for (;;) {
    // 两段式：先按 created_at 索引取一批 victim id，再按主键删除，
    // 避免 DELETE 外层对 timing_events 做全表哈希扫描。
    const victims = await db.pool.query<{ id: string }>(
      `SELECT ev.id
       FROM timing_events ev
       JOIN tutoring_episodes e ON e.id = ev.episode_id
       WHERE ev.created_at < $1
         AND (e.state = 'finished' OR (
           e.state = 'paused' AND NOT EXISTS (
             SELECT 1 FROM timing_segments seg
             WHERE seg.episode_id = e.id AND seg.end_at IS NULL
           )
         ))
         AND EXISTS (
           SELECT 1 FROM attempt_timing_snapshots s
           WHERE s.episode_id = ev.episode_id
         )
       ORDER BY ev.created_at
       LIMIT $2`,
      [cutoff, TIMING_CLEANUP_BATCH_SIZE],
    );
    batches += 1;
    if (victims.rows.length === 0) break;
    const result = await db.pool.query(
      "DELETE FROM timing_events WHERE id = ANY($1::uuid[])",
      [victims.rows.map((row) => row.id)],
    );
    deleted += result.rowCount ?? 0;
    if (victims.rows.length < TIMING_CLEANUP_BATCH_SIZE) break;
  }
  return { deleted, batches };
}

export function timingCleanupHandler(db: Database): JobHandler {
  return async () => cleanupSealedTimingEvents(db);
}

/**
 * Enqueues at most one cleanup run per UTC day. The job table's dedupe key
 * makes repeated calls on the same day a no-op, so restarts and multiple
 * instances cannot multiply the work.
 */
export async function enqueueDailyTimingCleanup(
  jobs: JobQueue,
  db: Database,
  now = new Date(),
): Promise<string> {
  return jobs.enqueue(db.pool, {
    kind: TIMING_CLEANUP_JOB_KIND,
    dedupeKey: `${TIMING_CLEANUP_JOB_KIND}:${now.toISOString().slice(0, 10)}`,
    payload: {},
  });
}

export function startTimingCleanupScheduler(
  jobs: JobQueue,
  db: Database,
  options: {
    now?: () => Date;
    intervalMs?: number;
    onError?: (error: unknown) => void;
  } = {},
): () => void {
  const now = options.now ?? (() => new Date());
  const enqueue = () =>
    enqueueDailyTimingCleanup(jobs, db, now()).catch((error: unknown) =>
      options.onError?.(error),
    );
  void enqueue();
  const timer = setInterval(() => void enqueue(), options.intervalMs ?? 3_600_000);
  timer.unref();
  return () => clearInterval(timer);
}
