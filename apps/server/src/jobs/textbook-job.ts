import type { JobHandler } from "./runner.js";
import type { CatalogService } from "../modules/catalog/service.js";
import { parseDocument } from "./parsers/pdf-process.js";
import type { OcrProvider } from "./parsers/ocr.js";
export function textbookHandler(
  catalog: CatalogService,
  ocr?: OcrProvider,
): JobHandler {
  return async (job, signal) => {
    const id = String(job.payload.revisionId);
    const row = (
      await catalog.db.pool.query(
        "SELECT f.* FROM textbook_revisions r JOIN files f ON f.id=r.file_id WHERE r.id=$1",
        [id],
      )
    ).rows[0];
    if (!row || row.purpose !== "textbook" || row.status !== "ready")
      throw Error("INVALID_TEXTBOOK_FILE");
    const store = catalog.uploads.store;
    if (!store) throw Error("OSS_NOT_CONFIGURED");
    const lease = { jobId: job.id, token: job.leaseToken };
    try {
      const bytes = await store.read(row.object_key);
      let count = 0;
      for await (const page of parseDocument({
        bytes,
        contentType: row.content_type,
        signal,
        ocr,
      })) {
        signal.throwIfAborted();
        await catalog.saveParsedPage(id, page, lease);
        count++;
      }
      await catalog.finishProcessing(id, lease);
      return { pageCount: count };
    } catch (error) {
      if (job.attempts >= 3)
        await catalog.db.pool.query(
          "UPDATE textbook_revisions SET status='failed' WHERE id=$1 AND status='processing' AND EXISTS(SELECT 1 FROM jobs WHERE id=$2 AND lease_token=$3 AND status='running')",
          [id, job.id, job.leaseToken],
        );
      throw error;
    }
  };
}
