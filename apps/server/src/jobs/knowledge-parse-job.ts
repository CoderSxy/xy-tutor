import { z } from "zod";
import type { ModelGateway } from "../agent/provider.js";
import type { Database } from "../../../../packages/db/src/client.js";
import { inTransaction } from "../../../../packages/db/src/client.js";
import type { FileStore } from "../infra/oss.js";
import { PermanentJobError } from "./errors.js";
import type { JobHandler } from "./runner.js";
import type { OcrProvider } from "./parsers/ocr.js";
import {
  extractBatchText,
  proposeKnowledgeItems,
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
    "UPDATE knowledge_parse_runs SET status='processing',error_code=NULL,completed_at=NULL WHERE id=$1",
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
    if (files.some((file) => file.status !== "ready"))
      throw new PermanentJobError("INVALID_KNOWLEDGE_SOURCE");
    const store = uploads.store;
    if (files.length && !store) throw Error("OSS_NOT_CONFIGURED");
    const text = await extractBatchText(
      { textContent: run.text_content, files },
      {
        read: (key) => store!.read(key),
        signal,
        ocr: options.ocr,
      },
    );
    if (!text.trim()) throw new PermanentJobError("EMPTY_KNOWLEDGE_SOURCE");

    const items = await proposeKnowledgeItems(
      gateway,
      text,
      run.extra_prompt,
      signal,
    );

    await inTransaction(db, async (tx) => {
      for (const item of items)
        await tx.query(
          "INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status,replaces_item_id) VALUES($1,$2,$3,$4,'pending_review',$5)",
          [
            run.batch_id,
            runId,
            item.title,
            item.summary,
            options.replacesItemId ?? null,
          ],
        );
      await tx.query(
        "UPDATE knowledge_parse_runs SET status='succeeded',model=$2,error_code=NULL,completed_at=now() WHERE id=$1",
        [runId, gateway.runtime.model.id],
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
