import { z } from "zod";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { Actor } from "../../../../../packages/contracts/src/domain.js";
import {
  KNOWLEDGE_ITEM_STATUSES,
  KNOWLEDGE_SOURCE_CONTENT_TYPES,
  createBatchInput,
  editItemInput,
  type KnowledgeBatchDTO,
  type KnowledgeItemDTO,
  type KnowledgeItemStatus,
  type KnowledgeParseRunDTO,
} from "../../../../../packages/contracts/src/knowledge-base.js";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { PoolClient } from "pg";
import type { JobQueue } from "../../jobs/queue.js";
import { requireAdmin } from "../auth/policy.js";
import { escapeLike } from "./search.js";

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

type ItemRow = {
  id: string;
  batch_id: string;
  parse_run_id: string;
  title: string;
  summary: string;
  status: KnowledgeItemStatus;
  replaces_item_id: string | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export const listItemsQuery = z
  .object({
    status: z.enum(KNOWLEDGE_ITEM_STATUSES).optional(),
    batchId: z.uuid().optional(),
    q: z.string().trim().min(1).max(255).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const itemIdsInput = z
  .object({ ids: z.array(z.uuid()).min(1).max(100) })
  .strict();

export const reparsePromptInput = z
  .object({ extraPrompt: z.string().trim().min(1).max(4000) })
  .strict();

async function replacementTarget(
  tx: PoolClient,
  candidate: ItemRow,
  replaced: Set<string>,
): Promise<string | null> {
  if (candidate.replaces_item_id && !replaced.has(candidate.replaces_item_id)) {
    const target = (
      await tx.query<{ id: string; status: string }>(
        "SELECT id,status FROM knowledge_items WHERE id=$1 FOR UPDATE",
        [candidate.replaces_item_id],
      )
    ).rows[0];
    if (!target || target.status !== "published")
      throw new AppError("CONFLICT", 409, "被替换的知识点未发布");
    return target.id;
  }
  const matches = (
    await tx.query<{ id: string }>(
      `SELECT id FROM knowledge_items
       WHERE batch_id=$1 AND status='published' AND title=$2
         AND NOT (id = ANY($3::uuid[]))
       FOR UPDATE`,
      [candidate.batch_id, candidate.title, [...replaced]],
    )
  ).rows;
  return matches.length === 1 ? matches[0]!.id : null;
}

function itemDTO(row: ItemRow): KnowledgeItemDTO {
  return {
    id: row.id,
    batchId: row.batch_id,
    parseRunId: row.parse_run_id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    replacesItemId: row.replaces_item_id,
    publishedAt: row.published_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function parseRunDTO(row: {
  id: string;
  batch_id: string;
  extra_prompt: string | null;
  model: string | null;
  status: string;
  error_code: string | null;
  item_count: number;
  notice: string | null;
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
    notice: row.notice,
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
        r.notice,r.created_at,r.completed_at
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

  async listItems(
    actor: Actor,
    query: {
      status?: KnowledgeItemStatus;
      batchId?: string;
      q?: string;
      limit: number;
      offset: number;
    },
  ): Promise<{ items: KnowledgeItemDTO[]; total: number }> {
    requireAdmin(actor);
    const filters: string[] = [];
    const params: unknown[] = [];
    if (query.status) {
      params.push(query.status);
      filters.push(`status=$${params.length}`);
    }
    if (query.batchId) {
      params.push(query.batchId);
      filters.push(`batch_id=$${params.length}`);
    }
    if (query.q) {
      params.push(`%${escapeLike(query.q)}%`);
      filters.push(
        `(title ILIKE $${params.length} ESCAPE '\\' OR summary ILIKE $${params.length} ESCAPE '\\')`,
      );
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const total = (
      await this.db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM knowledge_items ${where}`,
        params,
      )
    ).rows[0]!.n;
    const rows = await this.db.pool.query<ItemRow>(
      `SELECT id,batch_id,parse_run_id,title,summary,status,replaces_item_id,published_at,created_at,updated_at
       FROM knowledge_items ${where}
       ORDER BY updated_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.limit, query.offset],
    );
    return { items: rows.rows.map(itemDTO), total };
  }

  async updateItem(
    actor: Actor,
    id: string,
    input: unknown,
  ): Promise<KnowledgeItemDTO> {
    requireAdmin(actor);
    z.uuid().parse(id);
    const parsed = editItemInput.safeParse(input);
    if (!parsed.success)
      throw new AppError("VALIDATION", 422, "知识点参数不正确");
    return inTransaction(this.db, async (tx) => {
      const item = (
        await tx.query<ItemRow>(
          "SELECT id,batch_id,parse_run_id,title,summary,status,replaces_item_id,published_at,created_at,updated_at FROM knowledge_items WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!item) throw new AppError("NOT_FOUND", 404, "知识点不存在");
      if (item.status === "discarded")
        throw new AppError("CONFLICT", 409, "已丢弃的知识点不能修改");
      const updated = (
        await tx.query<ItemRow>(
          "UPDATE knowledge_items SET title=$2,summary=$3,updated_at=now() WHERE id=$1 RETURNING id,batch_id,parse_run_id,title,summary,status,replaces_item_id,published_at,created_at,updated_at",
          [id, parsed.data.title, parsed.data.summary],
        )
      ).rows[0]!;
      await tx.query(
        "INSERT INTO audit_events(actor_id,action,details) VALUES($1,'knowledge.item.update',$2)",
        [actor.userId, JSON.stringify({ itemId: id })],
      );
      return itemDTO(updated);
    });
  }

  async discardItems(actor: Actor, ids: string[]): Promise<void> {
    requireAdmin(actor);
    const unique = [...new Set(ids)];
    await inTransaction(this.db, async (tx) => {
      const rows = (
        await tx.query<{ id: string; status: string }>(
          "SELECT id,status FROM knowledge_items WHERE id=ANY($1::uuid[]) FOR UPDATE",
          [unique],
        )
      ).rows;
      if (rows.length !== unique.length)
        throw new AppError("NOT_FOUND", 404, "知识点不存在");
      if (rows.some((row) => row.status !== "pending_review"))
        throw new AppError("CONFLICT", 409, "只有待确认的知识点可以丢弃");
      await tx.query(
        "UPDATE knowledge_items SET status='discarded',updated_at=now() WHERE id=ANY($1::uuid[])",
        [unique],
      );
      await tx.query(
        "INSERT INTO audit_events(actor_id,action,details) VALUES($1,'knowledge.item.discard',$2)",
        [actor.userId, JSON.stringify({ itemIds: unique })],
      );
    });
  }

  async publishItems(actor: Actor, ids: string[]): Promise<KnowledgeItemDTO[]> {
    requireAdmin(actor);
    const unique = [...new Set(ids)];
    return inTransaction(this.db, async (tx) => {
      const rows = (
        await tx.query<ItemRow>(
          "SELECT id,batch_id,parse_run_id,title,summary,status,replaces_item_id,published_at,created_at,updated_at FROM knowledge_items WHERE id=ANY($1::uuid[]) FOR UPDATE",
          [unique],
        )
      ).rows;
      if (rows.length !== unique.length)
        throw new AppError("NOT_FOUND", 404, "知识点不存在");
      if (rows.some((row) => row.status !== "pending_review"))
        throw new AppError("CONFLICT", 409, "只有待确认的知识点可以发布");
      const byId = new Map(rows.map((row) => [row.id, row]));
      const replaced = new Set<string>();
      const published: KnowledgeItemDTO[] = [];
      for (const id of unique) {
        const candidate = byId.get(id)!;
        const targetId = await replacementTarget(tx, candidate, replaced);
        if (targetId) {
          const updated = (
            await tx.query<ItemRow>(
              "UPDATE knowledge_items SET title=$2,summary=$3,updated_at=now() WHERE id=$1 RETURNING id,batch_id,parse_run_id,title,summary,status,replaces_item_id,published_at,created_at,updated_at",
              [targetId, candidate.title, candidate.summary],
            )
          ).rows[0]!;
          await tx.query(
            "UPDATE knowledge_items SET status='discarded',updated_at=now() WHERE id=$1",
            [candidate.id],
          );
          replaced.add(targetId);
          published.push(itemDTO(updated));
          continue;
        }
        const updated = (
          await tx.query<ItemRow>(
            "UPDATE knowledge_items SET status='published',published_at=now(),updated_at=now() WHERE id=$1 RETURNING id,batch_id,parse_run_id,title,summary,status,replaces_item_id,published_at,created_at,updated_at",
            [candidate.id],
          )
        ).rows[0]!;
        published.push(itemDTO(updated));
      }
      await tx.query(
        "INSERT INTO audit_events(actor_id,action,details) VALUES($1,'knowledge.item.publish',$2)",
        [actor.userId, JSON.stringify({ itemIds: unique })],
      );
      return published;
    });
  }

  async reparseBatch(
    actor: Actor,
    batchId: string,
    input: unknown,
  ): Promise<KnowledgeParseRunDTO> {
    requireAdmin(actor);
    z.uuid().parse(batchId);
    const parsed = reparsePromptInput.safeParse(input);
    if (!parsed.success)
      throw new AppError("VALIDATION", 422, "再解析参数不正确");
    const batch = (
      await this.db.pool.query<{ id: string }>(
        "SELECT id FROM knowledge_batches WHERE id=$1",
        [batchId],
      )
    ).rows[0];
    if (!batch) throw new AppError("NOT_FOUND", 404, "批次不存在");
    return this.scheduleReparse(actor, batchId, parsed.data.extraPrompt, null);
  }

  async reparsePublished(
    actor: Actor,
    itemId: string,
    input: unknown,
  ): Promise<KnowledgeParseRunDTO> {
    requireAdmin(actor);
    z.uuid().parse(itemId);
    const parsed = reparsePromptInput.safeParse(input);
    if (!parsed.success)
      throw new AppError("VALIDATION", 422, "再解析参数不正确");
    const item = (
      await this.db.pool.query<{ batch_id: string; status: string }>(
        "SELECT batch_id,status FROM knowledge_items WHERE id=$1",
        [itemId],
      )
    ).rows[0];
    if (!item) throw new AppError("NOT_FOUND", 404, "知识点不存在");
    if (item.status !== "published")
      throw new AppError("CONFLICT", 409, "只有已发布知识点可以再解析");
    return this.scheduleReparse(
      actor,
      item.batch_id,
      parsed.data.extraPrompt,
      itemId,
    );
  }

  private async scheduleReparse(
    actor: Actor,
    batchId: string,
    extraPrompt: string,
    replacesItemId: string | null,
  ): Promise<KnowledgeParseRunDTO> {
    const runId = await inTransaction(this.db, async (tx) => {
      const run = (
        await tx.query<{ id: string }>(
          this.modelConfigured
            ? "INSERT INTO knowledge_parse_runs(batch_id,extra_prompt,status) VALUES($1,$2,'queued') RETURNING id"
            : "INSERT INTO knowledge_parse_runs(batch_id,extra_prompt,status,error_code,completed_at) VALUES($1,$2,'failed','MODEL_NOT_CONFIGURED',now()) RETURNING id",
          [batchId, extraPrompt],
        )
      ).rows[0]!;
      if (this.modelConfigured)
        await this.queue.enqueue(tx, {
          kind: "knowledge.parse",
          dedupeKey: "knowledge.parse:" + run.id,
          payload: replacesItemId
            ? { runId: run.id, replacesItemId }
            : { runId: run.id },
        });
      await tx.query(
        "INSERT INTO audit_events(actor_id,action,details) VALUES($1,'knowledge.reparse',$2)",
        [
          actor.userId,
          JSON.stringify({
            batchId,
            runId: run.id,
            ...(replacesItemId ? { replacesItemId } : {}),
          }),
        ],
      );
      return run.id;
    });
    const row = (
      await this.db.pool.query<{
        id: string;
        batch_id: string;
        extra_prompt: string | null;
        model: string | null;
        status: string;
        error_code: string | null;
        item_count: number;
        notice: string | null;
        created_at: Date;
        completed_at: Date | null;
      }>(
        `SELECT r.id,r.batch_id,r.extra_prompt,r.model,r.status,r.error_code,
          (SELECT count(*)::int FROM knowledge_items i WHERE i.parse_run_id=r.id) AS item_count,
          r.notice,r.created_at,r.completed_at
         FROM knowledge_parse_runs r WHERE r.id=$1`,
        [runId],
      )
    ).rows[0]!;
    return parseRunDTO(row);
  }
}
