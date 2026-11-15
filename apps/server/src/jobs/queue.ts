import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Database } from "../../../../packages/db/src/client.js";
export type Job = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  leaseToken: string;
  attempts: number;
};
export async function enqueueJob(
  tx: Pool | PoolClient,
  input: { kind: string; dedupeKey: string; payload: unknown },
): Promise<string> {
  return (
    await tx.query(
      "INSERT INTO jobs(kind,dedupe_key,payload) VALUES($1,$2,$3) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING id",
      [input.kind, input.dedupeKey, JSON.stringify(input.payload)],
    )
  ).rows[0].id;
}
export class JobQueue {
  constructor(private db: Database) {}
  async enqueue(
    tx: Pool | PoolClient,
    input: { kind: string; dedupeKey: string; payload: unknown },
  ): Promise<string> {
    return enqueueJob(tx, input);
  }
  async claim(_workerId: string, now: Date): Promise<Job | null> {
    // A crash on the final lease cannot be retried; repair processing projections atomically.
    await this.db.pool.query(
      `WITH exhausted AS (
      UPDATE jobs SET status='failed',error_code='INTERRUPTED',lease_token=NULL,lease_expires_at=NULL
      WHERE status='running' AND attempts>=3 AND lease_expires_at<$1 RETURNING kind,payload
    ), textbooks AS (
      UPDATE textbook_revisions r SET status='failed' FROM exhausted j
      WHERE j.kind='textbook.parse' AND r.id::text=j.payload->>'revisionId' AND r.status='processing'
    ), materials AS (
      UPDATE materials m SET status='failed' FROM exhausted j
      WHERE j.kind='material.parse' AND m.id::text=j.payload->>'materialId' AND m.status='processing'
    ), insights AS (
      UPDATE student_insight_reports r SET status='failed', error_code='INTERRUPTED', completed_at=$1
      FROM exhausted j
      WHERE j.kind='student.insight'
        AND r.id::text=j.payload->>'reportId'
        AND r.generation=(j.payload->>'generation')::int
        AND r.status IN ('queued','running')
    ), practice_sets_exhausted AS (
      UPDATE practice_sets s SET generation_status='failed', updated_at=$1
      FROM exhausted j
      WHERE j.kind='learning.practice-set'
        AND s.id::text=j.payload->>'setId'
        AND s.generation_status IN ('preparing')
    ), assessment_items AS (
      UPDATE practice_submission_items i
      SET grading_state='failed', reason_code='INTERRUPTED', updated_at=$1
      FROM exhausted j
      WHERE j.kind='learning.assess'
        AND i.attempt_id::text=j.payload->>'attemptId'
        AND i.grading_state IN ('queued','running')
    ), mistake_items AS (
      UPDATE practice_submission_items i
      SET mistake_sync_state='failed', reason_code='INTERRUPTED', updated_at=$1
      FROM exhausted j
      JOIN assessments s ON s.id::text=j.payload->>'assessmentId'
      JOIN attempts a ON a.id=s.attempt_id
      WHERE j.kind='learning.mistake-sync' AND i.attempt_id=a.id
        AND i.mistake_sync_state IN ('queued')
    ) SELECT count(*) FROM exhausted`,
      [now],
    );
    const token = randomUUID();
    const r = await this.db.pool.query(
      `WITH candidate AS (SELECT id FROM jobs WHERE attempts<3 AND ((status='queued' AND available_at<=$1) OR (status='running' AND lease_expires_at<$1)) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE jobs j SET status='running',attempts=attempts+1,lease_token=$2,lease_expires_at=$1+interval '30 seconds' FROM candidate c WHERE j.id=c.id RETURNING j.id,j.kind,j.payload,j.attempts`,
      [now, token],
    );
    const row = r.rows[0];
    return row ? { ...row, leaseToken: token } : null;
  }
  async heartbeat(
    jobId: string,
    token: string,
    now = new Date(),
  ): Promise<boolean> {
    return !!(
      await this.db.pool.query(
        "UPDATE jobs SET lease_expires_at=$3::timestamptz+interval '30 seconds' WHERE id=$1 AND lease_token=$2 AND status='running'",
        [jobId, token, now],
      )
    ).rowCount;
  }
  async finish(id: string, token: string, result: unknown): Promise<boolean> {
    return !!(
      await this.db.pool.query(
        "UPDATE jobs SET status='completed',result=$3,lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_token=$2 AND status='running'",
        [id, token, JSON.stringify(result)],
      )
    ).rowCount;
  }
  async fail(
    id: string,
    token: string,
    errorCode: string,
    now = new Date(),
    permanent = false,
  ): Promise<void> {
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      const job = (
        await client.query<{
          status: string;
          kind: string;
          payload: Record<string, unknown>;
        }>(
          `UPDATE jobs SET status=CASE WHEN $5::boolean OR attempts>=3 THEN 'failed' ELSE 'queued' END,
             available_at=$4::timestamptz+interval '10 seconds',
             lease_token=NULL,lease_expires_at=NULL,error_code=$3
           WHERE id=$1 AND lease_token=$2 AND status='running'
           RETURNING status,kind,payload`,
          [id, token, errorCode, now, permanent],
        )
      ).rows[0];
      if (job?.status === "failed" && job.kind === "textbook.parse") {
        const revisionId = job.payload.revisionId;
        if (typeof revisionId === "string")
          await client.query(
            "UPDATE textbook_revisions SET status='failed' WHERE id=$1 AND status='processing'",
            [revisionId],
          );
      }
      if (job?.status === "failed" && job.kind === "material.parse") {
        const materialId = job.payload.materialId;
        if (typeof materialId === "string")
          await client.query(
            "UPDATE materials SET status='failed' WHERE id=$1 AND status='processing'",
            [materialId],
          );
      }
      if (job?.kind === "student.insight") {
        const reportId = job.payload.reportId;
        const generation = job.payload.generation;
        if (typeof reportId === "string" && typeof generation === "number")
          await client.query(
            `UPDATE student_insight_reports
             SET status=$3, error_code=$4, completed_at=$5
             WHERE id=$1 AND generation=$2 AND status IN ('queued','running')`,
            [
              reportId,
              generation,
              job.status,
              errorCode,
              job.status === "failed" ? now : null,
            ],
          );
      }
      if (job?.kind === "learning.assess") {
        const attemptId = job.payload.attemptId;
        if (typeof attemptId === "string")
          await client.query(
            `UPDATE practice_submission_items
             SET grading_state=CASE WHEN $2='failed' THEN 'failed' ELSE 'queued' END,
                 reason_code=$3, updated_at=$4
             WHERE attempt_id=$1 AND grading_state IN ('queued','running','failed')`,
            [
              attemptId,
              job.status,
              job.status === "failed" ? "ASSESSMENT_FAILED" : null,
              now,
            ],
          );
      }
      if (job?.kind === "learning.practice-set") {
        const setId = job.payload.setId;
        if (typeof setId === "string" && job.status === "failed")
          await client.query(
            "UPDATE practice_sets SET generation_status='failed',updated_at=$2 WHERE id=$1 AND generation_status IN ('preparing','failed')",
            [setId, now],
          );
      }
      if (job?.kind === "learning.mistake-sync") {
        const assessmentId = job.payload.assessmentId;
        if (typeof assessmentId === "string")
          await client.query(
            `UPDATE practice_submission_items i
             SET mistake_sync_state=CASE WHEN $2='failed' THEN 'failed' ELSE 'queued' END,
                 reason_code=$3, updated_at=$4
             FROM assessments s JOIN attempts a ON a.id=s.attempt_id
             WHERE s.id=$1 AND i.attempt_id=a.id
               AND i.mistake_sync_state IN ('queued','failed')`,
            [
              assessmentId,
              job.status,
              job.status === "failed" ? "MISTAKE_SYNC_FAILED" : null,
              now,
            ],
          );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async retry(id: string, now = new Date()): Promise<boolean> {
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      const job = (
        await client.query<{
          kind: string;
          payload: Record<string, unknown>;
        }>(
          `UPDATE jobs SET status='queued',attempts=0,available_at=$2,
             lease_token=NULL,lease_expires_at=NULL,error_code=NULL
           WHERE id=$1 AND status='failed'
           RETURNING kind,payload`,
          [id, now],
        )
      ).rows[0];
      if (!job) return false;
      if (job.kind === "learning.assess") {
        const attemptId = job.payload.attemptId;
        if (typeof attemptId === "string")
          await client.query(
            "UPDATE practice_submission_items SET grading_state='queued',reason_code=NULL,updated_at=$2 WHERE attempt_id=$1 AND grading_state='failed'",
            [attemptId, now],
          );
      }
      if (job.kind === "learning.mistake-sync") {
        const assessmentId = job.payload.assessmentId;
        if (typeof assessmentId === "string")
          await client.query(
            `UPDATE practice_submission_items i SET mistake_sync_state='queued',reason_code=NULL,updated_at=$3
             FROM assessments s JOIN attempts a ON a.id=s.attempt_id
             WHERE s.id=$1 AND i.attempt_id=a.id AND i.mistake_sync_state='failed'`,
            [assessmentId, now, now],
          );
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
