import { z } from "zod";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { Actor } from "../../../../../packages/contracts/src/domain.js";
import {
  KNOWLEDGE_SOURCE_CONTENT_TYPES,
  createBatchInput,
  type KnowledgeBatchDTO,
  type KnowledgeParseRunDTO,
} from "../../../../../packages/contracts/src/knowledge-base.js";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { JobQueue } from "../../jobs/queue.js";
import { requireAdmin } from "../auth/policy.js";

type BatchRow = {
  id: string;
  text_content: string | null;
  created_at: Date;
};

type FileRow = {
  id: string;
  purpose: string;
  status: string;
  content_type: string;
};

function parseRunDTO(row: {
  id: string;
  batch_id: string;
  extra_prompt: string | null;
  model: string | null;
  status: string;
  error_code: string | null;
  item_count: number;
  created_at: Date;
  completed_at: Date | null;
}): KnowledgeParseRunDTO {
  return {
    id: row.id,
    batchId: row.batch_id,
    extraPrompt: row.extra_prompt,
    model: row.model,
    status: row.status as KnowledgeParseRunDTO["status"],
    errorCode: row.error_code,
    itemCount: row.item_count,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

export class KnowledgeBaseService {
  constructor(
    private db: Database,
    private queue: JobQueue,
    private modelConfigured: boolean,
  ) {}

  async createBatch(actor: Actor, input: unknown): Promise<KnowledgeBatchDTO> {
    requireAdmin(actor);
    const parsed = createBatchInput.safeParse(input);
    if (!parsed.success)
      throw new AppError("VALIDATION", 422, "批次参数不正确");
    const v = parsed.data;
    const batchId = await inTransaction(this.db, async (tx) => {
      if (v.fileIds.length) {
        const rows = (
          await tx.query<FileRow>(
            "SELECT id,purpose,status,content_type FROM files WHERE id = ANY($1::uuid[])",
            [v.fileIds],
          )
        ).rows;
        const byId = new Map(rows.map((row) => [row.id, row]));
        for (const fileId of v.fileIds) {
          const file = byId.get(fileId);
          if (!file) throw new AppError("NOT_FOUND", 404, "文件不存在");
          if (
            file.purpose !== "knowledge_source" ||
            file.status !== "ready"
          )
            throw new AppError("CONFLICT", 409, "文件尚未就绪或不是知识点资料");
          if (
            !KNOWLEDGE_SOURCE_CONTENT_TYPES.includes(
              file.content_type as (typeof KNOWLEDGE_SOURCE_CONTENT_TYPES)[number],
            )
          )
            throw new AppError("VALIDATION", 422, "文件类型不支持");
        }
      }
      const batch = (
        await tx.query<{ id: string }>(
          "INSERT INTO knowledge_batches(actor_id,text_content) VALUES($1,$2) RETURNING id",
          [actor.userId, v.text ?? null],
        )
      ).rows[0]!;
      for (const [position, fileId] of v.fileIds.entries()) {
        await tx.query(
          "INSERT INTO knowledge_batch_files(batch_id,file_id,position) VALUES($1,$2,$3)",
          [batch.id, fileId, position],
        );
      }
      const run = (
        await tx.query<{ id: string }>(
          this.modelConfigured
            ? "INSERT INTO knowledge_parse_runs(batch_id,extra_prompt,status) VALUES($1,$2,'queued') RETURNING id"
            : "INSERT INTO knowledge_parse_runs(batch_id,extra_prompt,status,error_code,completed_at) VALUES($1,$2,'failed','MODEL_NOT_CONFIGURED',now()) RETURNING id",
          [batch.id, v.extraPrompt ?? null],
        )
      ).rows[0]!;
      if (this.modelConfigured)
        await this.queue.enqueue(tx, {
          kind: "knowledge.parse",
          dedupeKey: "knowledge.parse:" + run.id,
          payload: { runId: run.id },
        });
      await tx.query(
        "INSERT INTO audit_events(actor_id,action,details) VALUES($1,'knowledge.batch.create',$2)",
        [actor.userId, JSON.stringify({ batchId: batch.id })],
      );
      return batch.id;
    });
    return this.getBatch(actor, batchId);
  }

  async getBatch(actor: Actor, batchId: string): Promise<KnowledgeBatchDTO> {
    requireAdmin(actor);
    z.uuid().parse(batchId);
    const batch = (
      await this.db.pool.query<BatchRow>(
        "SELECT id,text_content,created_at FROM knowledge_batches WHERE id=$1",
        [batchId],
      )
    ).rows[0];
    if (!batch) throw new AppError("NOT_FOUND", 404, "批次不存在");
    const files = await this.db.pool.query<{
      file_id: string;
      name: string;
      content_type: string;
    }>(
      "SELECT f.id AS file_id,f.name,f.content_type FROM knowledge_batch_files bf JOIN files f ON f.id=bf.file_id WHERE bf.batch_id=$1 ORDER BY bf.position",
      [batchId],
    );
    const runs = await this.db.pool.query(
      `SELECT r.id,r.batch_id,r.extra_prompt,r.model,r.status,r.error_code,
        (SELECT count(*)::int FROM knowledge_items i WHERE i.parse_run_id=r.id) AS item_count,
        r.created_at,r.completed_at
       FROM knowledge_parse_runs r WHERE r.batch_id=$1
       ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
      [batchId],
    );
    const counts = (
      await this.db.pool.query<{ pending: number; published: number }>(
        `SELECT count(*) FILTER (WHERE status='pending_review')::int AS pending,
          count(*) FILTER (WHERE status='published')::int AS published
         FROM knowledge_items WHERE batch_id=$1`,
        [batchId],
      )
    ).rows[0]!;
    return {
      id: batch.id,
      textContent: batch.text_content,
      files: files.rows.map((row) => ({
        fileId: row.file_id,
        name: row.name,
        contentType: row.content_type,
      })),
      latestRun: runs.rows[0] ? parseRunDTO(runs.rows[0]) : null,
      pendingCount: counts.pending,
      publishedCount: counts.published,
      createdAt: batch.created_at.toISOString(),
    };
  }

  async listBatches(
    actor: Actor,
    page: { limit: number; offset: number },
  ): Promise<{ items: KnowledgeBatchDTO[]; total: number }> {
    requireAdmin(actor);
    const total = (
      await this.db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM knowledge_batches",
      )
    ).rows[0]!.n;
    const rows = await this.db.pool.query<{ id: string }>(
      "SELECT id FROM knowledge_batches ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2",
      [page.limit, page.offset],
    );
    const items: KnowledgeBatchDTO[] = [];
    for (const row of rows.rows) items.push(await this.getBatch(actor, row.id));
    return { items, total };
  }
}
