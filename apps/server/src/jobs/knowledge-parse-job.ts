import { z } from "zod";
import type { ModelGateway } from "../agent/provider.js";
import type { Database } from "../../../../packages/db/src/client.js";
import { inTransaction } from "../../../../packages/db/src/client.js";
import type { FileStore } from "../infra/oss.js";
import { PermanentJobError } from "./errors.js";
import type { JobHandler } from "./runner.js";
import type { OcrProvider } from "./parsers/ocr.js";
import {
  MAX_KNOWLEDGE_ITEMS,
  extractBatchText,
  proposeKnowledgeItems,
  type KnowledgeProposal,
} from "../modules/knowledge-base/parser.js";

type RunRow = {
  id: string;
  batch_id: string;
  extra_prompt: string | null;
  status: string;
  text_content: string | null;
};

type SourceFileRow = {
  content_type: string;
  object_key: string;
  status: string;
};

const RUN_ERROR_CODES = new Set([
  "PDF_PAGE_LIMIT",
  "OCR_PAGE_LIMIT",
  "FILE_SIZE_LIMIT",
  "PDF_PARSE_FAILED",
  "PARSE_OUTPUT_LIMIT",
  "PARSE_TIMEOUT",
  "PARSE_STALLED",
  "IMAGE_PIXEL_LIMIT",
  "OCR_IMAGE_LIMIT",
  "OCR_UNAVAILABLE",
  "OSS_NOT_CONFIGURED",
  "PARSE_INVALID_OUTPUT",
  "INVALID_KNOWLEDGE_RUN",
  "INVALID_KNOWLEDGE_SOURCE",
  "EMPTY_KNOWLEDGE_SOURCE",
]);

function publishedReplacementId(
  item: KnowledgeProposal,
  published: { id: string; title: string }[],
  claimed: Set<string>,
): string | null {
  const title = item.sourceTitle ?? item.title;
  const hits = published.filter(
    (row) => row.title === title && !claimed.has(row.id),
  );
  return hits.length === 1 ? hits[0]!.id : null;
}

function runErrorCode(error: unknown): string {
  return error instanceof Error && RUN_ERROR_CODES.has(error.message)
    ? error.message
    : "PROCESSING_FAILED";
}

export async function parseKnowledgeRun(
  db: Database,
  gateway: ModelGateway,
  uploads: { store?: FileStore },
  runId: string,
  signal: AbortSignal,
  options: { replacesItemId?: string | null; ocr?: OcrProvider } = {},
): Promise<void> {
  const run = (
    await db.pool.query<RunRow>(
      `SELECT r.id,r.batch_id,r.extra_prompt,r.status,b.text_content
       FROM knowledge_parse_runs r JOIN knowledge_batches b ON b.id=r.batch_id
       WHERE r.id=$1`,
      [runId],
    )
  ).rows[0];
  if (!run) throw new PermanentJobError("INVALID_KNOWLEDGE_RUN");
  if (run.status === "succeeded") return;
  await db.pool.query(
    "UPDATE knowledge_parse_runs SET status='processing',error_code=NULL,notice=NULL,completed_at=NULL WHERE id=$1",
    [runId],
  );

  try {
    const files = (
      await db.pool.query<SourceFileRow>(
        `SELECT f.content_type,f.object_key,f.status
         FROM knowledge_batch_files bf JOIN files f ON f.id=bf.file_id
         WHERE bf.batch_id=$1 ORDER BY bf.position`,
        [run.batch_id],
      )
    ).rows;
    const store = uploads.store;
    let focus: { title: string; summary: string } | undefined;
    if (options.replacesItemId) {
      const source = (
        await db.pool.query<{ title: string; summary: string }>(
          "SELECT title,summary FROM knowledge_items WHERE id=$1",
          [options.replacesItemId],
        )
      ).rows[0];
      if (!source) throw new PermanentJobError("INVALID_KNOWLEDGE_RUN");
      focus = source;
    }
    const publishedItems = focus
      ? []
      : (
          await db.pool.query<{ id: string; title: string; summary: string }>(
            `SELECT id,title,summary FROM knowledge_items
             WHERE batch_id=$1 AND status='published'
             ORDER BY updated_at DESC, id DESC LIMIT 30`,
            [run.batch_id],
          )
        ).rows;
    let text = focus ? `标题：${focus.title}\n总结：${focus.summary}` : "";
    let truncated = false;
    let sourceNotice: string | null = null;
    const readableFiles = files.length > 0 && !store ? [] : files;
    if (files.some((file) => file.status !== "ready"))
      throw new PermanentJobError("INVALID_KNOWLEDGE_SOURCE");
    if (files.length && !store) {
      if (!focus) throw Error("OSS_NOT_CONFIGURED");
      sourceNotice = run.text_content
        ? "未能读取原始文件，本次只附带了批次中的文本。"
        : "未能读取原始文件，本次只依据当前知识点修订。";
    }
    if (!focus || run.text_content || readableFiles.length) {
      const extracted = await extractBatchText(
        { textContent: run.text_content, files: readableFiles },
        {
          read: (key) => store!.read(key),
          signal,
          ocr: options.ocr,
        },
      );
      if (extracted.text.trim()) text = extracted.text;
      truncated = extracted.truncated;
    }
    if (!text.trim()) throw new PermanentJobError("EMPTY_KNOWLEDGE_SOURCE");

    const proposed = await proposeKnowledgeItems(
      gateway,
      text,
      run.extra_prompt,
      signal,
      {
        focus,
        publishedItems: publishedItems.map(({ title, summary }) => ({
          title,
          summary,
        })),
      },
    );
    const notices = [
      sourceNotice ?? "",
      truncated ? "资料超过 8 万字，已截断后继续解析。" : "",
      proposed.omittedItemCount > 0
        ? `解析结果超过 ${MAX_KNOWLEDGE_ITEMS} 条，只保留前 ${MAX_KNOWLEDGE_ITEMS} 条。`
        : "",
    ].filter(Boolean);

    await inTransaction(db, async (tx) => {
      await tx.query(
        "SELECT id FROM knowledge_parse_runs WHERE id=$1 FOR UPDATE",
        [runId],
      );
      const existing = (
        await tx.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM knowledge_items WHERE parse_run_id=$1",
          [runId],
        )
      ).rows[0]!.n;
      if (!existing) {
        const claimed = new Set<string>();
        for (const [index, item] of proposed.items.entries()) {
          const replacesItemId =
            options.replacesItemId && index === 0
              ? options.replacesItemId
              : options.replacesItemId
                ? null
                : publishedReplacementId(item, publishedItems, claimed);
          if (replacesItemId) claimed.add(replacesItemId);
          await tx.query(
            "INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status,replaces_item_id) VALUES($1,$2,$3,$4,'pending_review',$5)",
            [run.batch_id, runId, item.title, item.summary, replacesItemId],
          );
        }
      }
      await tx.query(
        "UPDATE knowledge_parse_runs SET status='succeeded',model=$2,error_code=NULL,notice=$3,completed_at=now() WHERE id=$1",
        [runId, gateway.runtime.model.id, notices.join("") || null],
      );
    });
  } catch (error) {
    await db.pool.query(
      "UPDATE knowledge_parse_runs SET status='failed',error_code=$2,completed_at=now() WHERE id=$1",
      [runId, signal.aborted ? "INTERRUPTED" : runErrorCode(error)],
    );
    throw error;
  }
}

export function knowledgeParseHandler(
  db: Database,
  gateway: ModelGateway,
  uploads: { store?: FileStore },
  ocr?: OcrProvider,
): JobHandler {
  return async (job, signal) => {
    const payload = z
      .object({
        runId: z.uuid(),
        replacesItemId: z.uuid().optional(),
      })
      .parse(job.payload);
    await parseKnowledgeRun(db, gateway, uploads, payload.runId, signal, {
      replacesItemId: payload.replacesItemId,
      ocr,
    });
    return { runId: payload.runId };
  };
}
