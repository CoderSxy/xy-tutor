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
export class JobQueue {
  constructor(private db: Database) {}
  async enqueue(
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
          `UPDATE jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
             available_at=$4::timestamptz+interval '10 seconds',
             lease_token=NULL,lease_expires_at=NULL,error_code=$3
           WHERE id=$1 AND lease_token=$2 AND status='running'
           RETURNING status,kind,payload`,
          [id, token, errorCode, now],
        )
      ).rows[0];
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
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
