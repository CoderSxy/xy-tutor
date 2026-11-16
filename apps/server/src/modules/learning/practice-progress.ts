import { enqueueJob } from "../../jobs/queue.js";
import type {
  PracticeCounts,
  PracticeItemProgress,
  PracticeSubmissionState,
} from "../../../../../packages/contracts/src/practice-sets.js";

type Queryable = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};

export type PracticeProgressSnapshot = {
  items: PracticeItemProgress[];
};

export type PracticeProgress = {
  submission: PracticeSubmissionState;
  counts: PracticeCounts;
  canContinue: boolean;
};

export function computePracticeProgress(
  snapshot: PracticeProgressSnapshot,
): PracticeProgress {
  const items = snapshot.items;
  const submitted = items.filter((item) => item.submission === "submitted").length;
  const skipped = items.filter((item) => item.submission === "skipped").length;
  const verified = items.filter((item) => item.grading === "verified").length;
  const pending = items.filter((item) => item.grading === "pending").length;
  const hasQueued = items.some(
    (item) => item.grading === "queued" || item.grading === "running",
  );
  const hasFailed = items.some((item) => item.grading === "failed");
  const hasUnsynced = items.some(
    (item) => item.mistakeSync === "queued" || item.mistakeSync === "failed",
  );
  const resolved =
    items.length === 5 &&
    items.every(
      (item) =>
        item.submission === "skipped" ||
        (item.submission === "submitted" && item.grading === "verified"),
    );
  const canContinue =
    resolved && pending === 0 && !hasQueued && !hasFailed && !hasUnsynced;
  let submission: PracticeSubmissionState = "open";
  if (canContinue) submission = "completed";
  else if (pending > 0) submission = "needs_review";
  else if (submitted > 0 || skipped > 0 || hasQueued || hasFailed || hasUnsynced)
    submission = "grading";
  return {
    submission,
    counts: { total: 5, submitted, skipped, verified, pending },
    canContinue,
  };
}

export async function loadPracticeItemProgress(
  db: Queryable,
  setId: string,
): Promise<PracticeItemProgress[]> {
  const rows = (
    await db.query(
      `SELECT sl.id AS slot_id, sl.task_item_id AS item_id,
              si.submission_id, si.state AS submission, si.grading_state AS grading,
              si.mistake_sync_state AS mistake_sync, a.correctness
       FROM practice_set_slots sl
       LEFT JOIN LATERAL (
         SELECT psi.submission_id, psi.state, psi.grading_state, psi.mistake_sync_state,
                psi.latest_assessment_id
         FROM practice_submission_items psi
         WHERE psi.task_item_id = sl.task_item_id
         ORDER BY psi.created_at DESC, psi.id DESC
         LIMIT 1
       ) si ON true
       LEFT JOIN assessments a ON a.id = si.latest_assessment_id
       WHERE sl.set_id=$1
       ORDER BY sl.position`,
      [setId],
    )
  ).rows as Array<{
    submission_id: string | null;
    slot_id: string;
    item_id: string | null;
    submission: string | null;
    grading: string | null;
    mistake_sync: string | null;
    correctness: PracticeItemProgress["correctness"];
  }>;
  return rows.map((row) => ({
    itemId: row.item_id ?? row.slot_id,
    ...(row.submission_id ? { submissionId: row.submission_id } : {}),
    submission:
      row.submission === "submitted" || row.submission === "skipped"
        ? row.submission
        : "unanswered",
    grading:
      row.grading === "queued" ||
      row.grading === "running" ||
      row.grading === "verified" ||
      row.grading === "pending" ||
      row.grading === "failed"
        ? row.grading
        : "none",
    correctness: row.correctness ?? null,
    mistakeSync:
      row.mistake_sync === "queued" ||
      row.mistake_sync === "synced" ||
      row.mistake_sync === "failed"
        ? row.mistake_sync
        : "not_required",
  }));
}

export async function refreshPracticeSetState(
  db: Queryable,
  setId: string,
): Promise<PracticeProgress> {
  const items = await loadPracticeItemProgress(db, setId);
  const progress = computePracticeProgress({ items });
  await db.query(
    "UPDATE practice_sets SET submission_status=$2, updated_at=now() WHERE id=$1",
    [setId, progress.submission],
  );
  if (!progress.canContinue) return progress;
  const task = (
    await db.query(
      `SELECT t.id, t.version FROM practice_sets s
       JOIN learning_tasks t ON t.id=s.task_id
       WHERE s.id=$1 AND t.status IN ('active','paused')`,
      [setId],
    )
  ).rows[0] as { id: string; version: number } | undefined;
  if (!task) return progress;
  const updated = (
    await db.query(
      `UPDATE learning_tasks SET status='completed', version=version+1, updated_at=now()
       WHERE id=$1 AND status IN ('active','paused') RETURNING version`,
      [task.id],
    )
  ).rows[0] as { version: number } | undefined;
  if (updated)
    await enqueueJob(db as never, {
      kind: "learning.summary",
      dedupeKey: `summary:${task.id}:${updated.version}`,
      payload: { taskId: task.id },
    });
  return progress;
}
