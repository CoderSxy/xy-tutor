import { z } from "zod";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { AdminInsightScope } from "../../../../../packages/contracts/src/student-insights.js";
import type { Database } from "../../../../../packages/db/src/client.js";
import type { FileStore } from "../../infra/oss.js";
import { auditInsight } from "./policy.js";

const DOWNLOAD_TTL_SECONDS = 300;

const FILE_AUTHORIZED = `f.id = $1 AND f.status = 'ready' AND (
  EXISTS (
    SELECT 1 FROM materials m
    WHERE m.file_id = f.id AND m.student_id = $2
  )
  OR EXISTS (
    SELECT 1
    FROM message_attachments ma
    JOIN message_versions mv ON mv.id = ma.message_version_id
    JOIN messages msg ON msg.id = mv.message_id
      AND msg.current_version = mv.version_no
    JOIN conversations c ON c.id = msg.conversation_id
    LEFT JOIN learning_tasks t ON t.id = c.task_id
    WHERE ma.file_id = f.id
      AND c.student_id = $2
      AND (c.task_id IS NULL OR t.deleted_at IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM evidence_invalidations i
        WHERE i.student_id = $2 AND i.evidence_version_id = mv.id
      )
  )
)`;

type FileRow = {
  objectKey: string;
  contentType: string;
};

export class InsightFileService {
  constructor(
    private readonly database: Database,
    private readonly store?: FileStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async audit(
    scope: AdminInsightScope,
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      await auditInsight(client, scope, action, details);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async download(
    scope: AdminInsightScope,
    fileId: string,
    requestId?: string,
  ): Promise<{ url: string; contentType: string; expiresAt: string }> {
    z.uuid().parse(fileId);
    const client = await this.database.pool.connect();
    let row: FileRow | undefined;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await client.query<FileRow>(
        `SELECT f.object_key AS "objectKey",
           f.content_type AS "contentType"
         FROM files f
         WHERE ${FILE_AUTHORIZED}`,
        [fileId, scope.studentId],
      );
      row = result.rows[0];
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (!row) throw new AppError("NOT_FOUND", 404, "文件不存在");
    if (!this.store)
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        503,
        "文件存储尚未配置，请联系管理员",
      );

    const url = await this.store.signDownload(row.objectKey, DOWNLOAD_TTL_SECONDS);
    await this.audit(scope, "student_insight.file_download", { fileId, requestId });
    return {
      url,
      contentType: row.contentType,
      expiresAt: new Date(
        this.now().getTime() + DOWNLOAD_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  }
}
