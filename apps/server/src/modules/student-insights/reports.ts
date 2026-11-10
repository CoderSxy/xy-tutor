import type { PoolClient } from "pg";
import { z } from "zod";
import type { Database } from "../../../../../packages/db/src/client.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import {
  INSIGHT_PROMPT_VERSION,
  INSIGHT_TIMEZONE,
  METRIC_VERSION,
  type AdminInsightScope,
  type InsightEvidence,
  type InsightFilter,
  type ReportCreateResult,
  type ReportDTO,
  type ReportHistory,
  type ReportRetryResult,
  type ReportStatus,
  type ReportSummary,
  type InsightEvidenceDetail,
} from "../../../../../packages/contracts/src/student-insights.js";
import { JobQueue } from "../../jobs/queue.js";
import { auditInsight } from "./policy.js";
import { buildInsightSnapshot, hashInsightSnapshot } from "./snapshot.js";

const REPORT_KIND = "student.insight";
const QUOTA_WINDOW_SECONDS = 60;
const QUOTA_LIMIT = 3;
const QUOTA_ACTIONS = [
  "student_insight.report_created",
  "student_insight.report_retried",
];

type ReportRow = {
  id: string;
  studentId: string;
  status: ReportStatus;
  from: string;
  to: string;
  revisionId: string | null;
  dataAsOf: string;
  generation: number;
  attempts: number;
  content: ReportDTO["content"];
  model: string | null;
  errorCode: string | null;
  evidenceCatalog: InsightEvidence[];
  createdAt: Date;
  completedAt: Date | null;
};

type ReportSummaryRow = Omit<
  ReportRow,
  "content" | "dataAsOf" | "evidenceCatalog"
> & {
  dataAsOf: string;
  evidenceCount: number;
};

const REPORT_SELECT = `
  SELECT r.id, r.student_id AS "studentId", r.status,
    to_char(r.from_date,'YYYY-MM-DD') AS "from",
    to_char(r.to_date,'YYYY-MM-DD') AS "to",
    r.revision_id AS "revisionId",
    r.snapshot #>> '{meta,dataAsOf}' AS "dataAsOf",
    r.generation, COALESCE(j.attempts, 0) AS attempts,
    r.content, r.model, r.error_code AS "errorCode",
    r.evidence_catalog AS "evidenceCatalog",
    r.created_at AS "createdAt", r.completed_at AS "completedAt"
  FROM student_insight_reports r
  LEFT JOIN jobs j ON j.id = r.job_id`;

function filterOf(row: {
  from: string;
  to: string;
  revisionId: string | null;
}): InsightFilter {
  return {
    from: row.from,
    to: row.to,
    ...(row.revisionId ? { revisionId: row.revisionId } : {}),
  };
}

function toDTO(row: ReportRow, evidence: InsightEvidence[]): ReportDTO {
  return {
    id: row.id,
    studentId: row.studentId,
    status: row.status,
    filter: filterOf(row),
    dataAsOf: row.dataAsOf,
    generation: row.generation,
    attempts: row.attempts,
    content: row.content,
    model: row.model,
    errorCode: row.errorCode,
    evidence,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function toSummary(row: ReportSummaryRow): ReportSummary {
  return {
    id: row.id,
    studentId: row.studentId,
    status: row.status,
    filter: filterOf(row),
    dataAsOf: row.dataAsOf,
    generation: row.generation,
    attempts: row.attempts,
    model: row.model,
    errorCode: row.errorCode,
    evidenceCount: row.evidenceCount,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

type Availability = { taskId: string | null; mistakeId?: string | null };

async function availableByKind(
  tx: PoolClient,
  studentId: string,
  evidence: InsightEvidence[],
): Promise<Map<string, Availability>> {
  const result = new Map<string, Availability>();
  const keysOf = (kind: InsightEvidence["kind"], field: "id" | "versionId") =>
    evidence
      .filter((item) => item.kind === kind)
      .map((item) => item[field]!)
      .filter(Boolean);
  const attempts = keysOf("attempt", "id");
  if (attempts.length)
    for (const row of (
      await tx.query<{ id: string; taskId: string | null }>(
        `SELECT a.id, a.task_id AS "taskId"
         FROM attempts a
         LEFT JOIN learning_tasks t ON t.id = a.task_id
         WHERE a.id = ANY($1::uuid[]) AND a.student_id = $2
           AND a.task_id IS NOT NULL
           AND (t.id IS NULL OR t.deleted_at IS NULL)
           AND NOT EXISTS (
             SELECT 1 FROM evidence_invalidations i
             WHERE i.student_id = $2
               AND i.evidence_version_id IN (a.question_version_id, a.message_version_id)
           )`,
        [attempts, studentId],
      )
    ).rows)
      result.set(`attempt:${row.id}`, { taskId: row.taskId });
  const versions = keysOf("message_version", "versionId");
  if (versions.length)
    for (const row of (
      await tx.query<{ id: string; taskId: string | null }>(
        `SELECT v.id, c.task_id AS "taskId"
         FROM message_versions v
         JOIN messages m ON m.id = v.message_id
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN learning_tasks t ON t.id = c.task_id
         WHERE v.id = ANY($1::uuid[]) AND c.student_id = $2
           AND (c.task_id IS NULL OR t.deleted_at IS NULL)
           AND NOT EXISTS (
             SELECT 1 FROM evidence_invalidations i
             WHERE i.student_id = $2 AND i.evidence_version_id = v.id
           )`,
        [versions, studentId],
      )
    ).rows)
      result.set(`message_version:${row.id}`, { taskId: row.taskId });
  const materials = keysOf("material", "id");
  if (materials.length)
    for (const row of (
      await tx.query<{ id: string }>(
        "SELECT id FROM materials WHERE id = ANY($1::uuid[]) AND student_id = $2",
        [materials, studentId],
      )
    ).rows)
      result.set(`material:${row.id}`, { taskId: null });
  const events = keysOf("mistake_event", "id");
  if (events.length)
    for (const row of (
      await tx.query<{ id: string; mistakeId: string }>(
        `SELECT e.id, e.mistake_id AS "mistakeId"
         FROM mistake_state_events e
         JOIN student_mistakes m ON m.id = e.mistake_id
         WHERE e.id = ANY($1::uuid[]) AND m.student_id = $2`,
        [events, studentId],
      )
    ).rows)
      result.set(`mistake_event:${row.id}`, {
        taskId: null,
        mistakeId: row.mistakeId,
      });
  return result;
}

async function validEvidence(
  tx: PoolClient,
  studentId: string,
  evidence: InsightEvidence[],
): Promise<InsightEvidence[]> {
  if (!evidence.length) return [];
  const available = await availableByKind(tx, studentId, evidence);
  return evidence.filter((item) => {
    const entry = available.get(item.key);
    if (!entry) return false;
    if (item.kind === "material" || item.kind === "mistake_event") return true;
    return !!entry.taskId;
  });
}

function hrefFor(
  studentId: string,
  evidence: InsightEvidence,
  entry: Availability,
): string {
  const base = `/admin/students/${studentId}`;
  if (evidence.kind === "material") return `${base}/materials/${evidence.id}`;
  if (evidence.kind === "mistake_event")
    return `${base}/mistakes/${entry.mistakeId}`;
  return `${base}/records/${entry.taskId}`;
}

export class InsightReportService {
  private readonly queue: JobQueue;

  constructor(
    private readonly database: Database,
    private readonly gatewayConfigured: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.queue = new JobQueue(database);
  }

  private requireGateway(): void {
    if (!this.gatewayConfigured)
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        503,
        "AI 报告未配置模型，暂时无法生成",
      );
  }

  private async transaction<T>(
    scope: AdminInsightScope,
    fn: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.database.pool.connect();
    let actorLocked = false;
    let studentLocked = false;
    let destroy = false;
    try {
      // Acquire session locks BEFORE BEGIN so waiting requests take a fresh
      // repeatable-read snapshot after the previous creator has committed.
      await client.query(
        "SELECT pg_advisory_lock(hashtext('student_insight_report_quota'), hashtext($1))",
        [scope.actor.userId],
      );
      actorLocked = true;
      await client.query(
        "SELECT pg_advisory_lock(hashtext('student_insight_report'), hashtext($1))",
        [scope.studentId],
      );
      studentLocked = true;
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        destroy = true;
      });
      throw error;
    } finally {
      try {
        if (studentLocked)
          await client.query(
            "SELECT pg_advisory_unlock(hashtext('student_insight_report'), hashtext($1))",
            [scope.studentId],
          );
        if (actorLocked)
          await client.query(
            "SELECT pg_advisory_unlock(hashtext('student_insight_report_quota'), hashtext($1))",
            [scope.actor.userId],
          );
      } catch {
        // Never return a connection holding session locks to the pool.
        destroy = true;
      }
      client.release(destroy);
    }
  }

  private async assertNoActiveReport(
    tx: PoolClient,
    studentId: string,
  ): Promise<void> {
    const active = (
      await tx.query<{ id: string }>(
        `SELECT id FROM student_insight_reports
       WHERE student_id=$1 AND status IN ('queued','running') LIMIT 1`,
        [studentId],
      )
    ).rows[0];
    if (active)
      throw new AppError(
        "CONFLICT",
        409,
        "该学生已有正在生成的报告，请等待完成后再生成",
        { reportId: active.id },
      );
  }

  private async assertQuota(
    tx: PoolClient,
    actorId: string,
    now: Date,
  ): Promise<void> {
    const used = (
      await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_events
         WHERE actor_id = $1 AND action = ANY($2::text[])
           AND created_at > $3::timestamptz - ($4 || ' seconds')::interval`,
        [actorId, QUOTA_ACTIONS, now, QUOTA_WINDOW_SECONDS],
      )
    ).rows[0]!.n;
    if (used >= QUOTA_LIMIT)
      throw new AppError("RATE_LIMITED", 429, "报告生成过于频繁，请稍后重试");
  }

  async create(
    scope: AdminInsightScope,
    filter: InsightFilter,
  ): Promise<ReportCreateResult> {
    this.requireGateway();
    const now = this.now();
    return this.transaction(scope, async (tx) => {
      const snapshot = await buildInsightSnapshot(tx, scope, filter, now);
      if (!snapshot.evidence.length)
        throw new AppError(
          "VALIDATION",
          422,
          "暂无可分析的学习记录，请先积累学习数据",
        );
      const hash = hashInsightSnapshot(snapshot);
      const existing = (
        await tx.query<{ id: string; status: ReportStatus }>(
          `SELECT id, status FROM student_insight_reports
           WHERE student_id = $1 AND metric_version = $2 AND prompt_version = $3
             AND snapshot_hash = $4
             AND COALESCE(revision_id, '00000000-0000-0000-0000-000000000000'::uuid)
               = COALESCE($5::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
           LIMIT 1`,
          [
            scope.studentId,
            METRIC_VERSION,
            INSIGHT_PROMPT_VERSION,
            hash,
            filter.revisionId ?? null,
          ],
        )
      ).rows[0];
      if (existing)
        return {
          reportId: existing.id,
          status: existing.status,
          reused: true,
        };
      await this.assertNoActiveReport(tx, scope.studentId);
      await this.assertQuota(tx, scope.actor.userId, now);
      const created = (
        await tx.query<{
          id: string;
          status: ReportStatus;
          generation: number;
        }>(
          `INSERT INTO student_insight_reports(
             student_id, requested_by, from_date, to_date, timezone, revision_id,
             metric_version, prompt_version, snapshot_hash, snapshot, evidence_catalog
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id, status, generation`,
          [
            scope.studentId,
            scope.actor.userId,
            snapshot.filter.from,
            snapshot.filter.to,
            INSIGHT_TIMEZONE,
            snapshot.filter.revisionId ?? null,
            METRIC_VERSION,
            INSIGHT_PROMPT_VERSION,
            hash,
            JSON.stringify(snapshot),
            JSON.stringify(snapshot.evidence),
          ],
        )
      ).rows[0]!;
      const jobId = await this.queue.enqueue(tx, {
        kind: REPORT_KIND,
        dedupeKey: `${REPORT_KIND}:${created.id}:${created.generation}`,
        payload: { reportId: created.id, generation: created.generation },
      });
      await tx.query(
        "UPDATE student_insight_reports SET job_id = $2 WHERE id = $1",
        [created.id, jobId],
      );
      await auditInsight(tx, scope, "student_insight.report_created", {
        reportId: created.id,
        from: snapshot.filter.from,
        to: snapshot.filter.to,
        revisionId: snapshot.filter.revisionId ?? null,
        snapshotHash: hash,
        sample: snapshot.sample,
      });
      return {
        reportId: created.id,
        status: created.status,
        reused: false,
      };
    });
  }

  async list(
    scope: AdminInsightScope,
    page: { limit: number; offset: number },
  ): Promise<ReportHistory> {
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const total = (
        await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM student_insight_reports WHERE student_id = $1",
          [scope.studentId],
        )
      ).rows[0]!.n;
      const rows = (
        await client.query<ReportSummaryRow>(
          `SELECT r.id, r.student_id AS "studentId", r.status,
             to_char(r.from_date,'YYYY-MM-DD') AS "from",
             to_char(r.to_date,'YYYY-MM-DD') AS "to",
             r.revision_id AS "revisionId",
             r.snapshot #>> '{meta,dataAsOf}' AS "dataAsOf",
             r.generation, COALESCE(j.attempts, 0) AS attempts,
             r.model, r.error_code AS "errorCode",
             jsonb_array_length(r.evidence_catalog) AS "evidenceCount",
             r.created_at AS "createdAt", r.completed_at AS "completedAt"
           FROM student_insight_reports r
           LEFT JOIN jobs j ON j.id = r.job_id
           WHERE r.student_id = $1
           ORDER BY r.created_at DESC, r.id DESC
           LIMIT $2 OFFSET $3`,
          [scope.studentId, page.limit, page.offset],
        )
      ).rows;
      await client.query("COMMIT");
      return { items: rows.map(toSummary), total };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async get(scope: AdminInsightScope, reportId: string): Promise<ReportDTO> {
    z.uuid().parse(reportId);
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const row = (
        await client.query<ReportRow>(
          `${REPORT_SELECT} WHERE r.id = $1 AND r.student_id = $2`,
          [reportId, scope.studentId],
        )
      ).rows[0];
      if (!row) throw new AppError("NOT_FOUND", 404, "报告不存在");
      const evidence = await validEvidence(
        client,
        scope.studentId,
        row.evidenceCatalog,
      );
      await client.query("COMMIT");
      return toDTO(row, evidence);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async retry(
    scope: AdminInsightScope,
    reportId: string,
  ): Promise<ReportRetryResult> {
    this.requireGateway();
    z.uuid().parse(reportId);
    const now = this.now();
    return this.transaction(scope, async (tx) => {
      const row = (
        await tx.query<{ status: ReportStatus; generation: number }>(
          `SELECT status, generation FROM student_insight_reports
           WHERE id = $1 AND student_id = $2 FOR UPDATE`,
          [reportId, scope.studentId],
        )
      ).rows[0];
      if (!row) throw new AppError("NOT_FOUND", 404, "报告不存在");
      if (row.status !== "failed")
        throw new AppError("CONFLICT", 409, "只有失败的报告可以重试");
      await this.assertQuota(tx, scope.actor.userId, now);
      await this.assertNoActiveReport(tx, scope.studentId);
      const generation = row.generation + 1;
      const jobId = await this.queue.enqueue(tx, {
        kind: REPORT_KIND,
        dedupeKey: `${REPORT_KIND}:${reportId}:${generation}`,
        payload: { reportId, generation },
      });
      await tx.query(
        `UPDATE student_insight_reports
         SET status = 'queued', generation = $2, job_id = $3,
           error_code = NULL, started_at = NULL, completed_at = NULL
         WHERE id = $1`,
        [reportId, generation, jobId],
      );
      await auditInsight(tx, scope, "student_insight.report_retried", {
        reportId,
        generation,
      });
      return { reportId, status: "queued" as const, generation };
    });
  }

  async resolveEvidence(
    scope: AdminInsightScope,
    reportId: string,
    evidenceKey: string,
  ): Promise<InsightEvidenceDetail> {
    z.uuid().parse(reportId);
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const row = (
        await client.query<{ evidenceCatalog: InsightEvidence[] }>(
          `SELECT evidence_catalog AS "evidenceCatalog"
           FROM student_insight_reports
           WHERE id = $1 AND student_id = $2`,
          [reportId, scope.studentId],
        )
      ).rows[0];
      if (!row) throw new AppError("NOT_FOUND", 404, "报告不存在");
      const evidence = row.evidenceCatalog.find(
        (item) => item.key === evidenceKey,
      );
      if (!evidence) throw new AppError("NOT_FOUND", 404, "证据不存在");
      const available = await availableByKind(client, scope.studentId, [
        evidence,
      ]);
      const entry = available.get(evidence.key);
      if (
        !entry ||
        (evidence.kind !== "material" &&
          evidence.kind !== "mistake_event" &&
          !entry.taskId)
      )
        throw new AppError("NOT_FOUND", 404, "证据已删除或失效");
      await client.query("COMMIT");
      return {
        href: hrefFor(scope.studentId, evidence, entry),
        detail: evidence,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
