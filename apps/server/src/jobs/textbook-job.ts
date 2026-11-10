import {
  MAX_TEXTBOOK_PAGES,
  MAX_TEXTBOOK_PDF_BYTES,
} from "../../../../packages/contracts/src/file-limits.js";
import type { JobHandler } from "./runner.js";
import type { CatalogService } from "../modules/catalog/service.js";
import { parseDocument } from "./parsers/pdf-process.js";
import { PermanentJobError } from "./errors.js";
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
      throw new PermanentJobError("INVALID_TEXTBOOK_FILE");
    const store = catalog.uploads.store;
    if (!store) throw Error("OSS_NOT_CONFIGURED");
    const lease = { jobId: job.id, token: job.leaseToken };
    let count = 0;
    for await (const page of parseDocument({
      read: () => store.read(row.object_key),
      contentType: row.content_type,
      signal,
      ocr,
      maxPages: MAX_TEXTBOOK_PAGES,
      maxBytes: MAX_TEXTBOOK_PDF_BYTES - 1,
    })) {
      signal.throwIfAborted();
      await catalog.saveParsedPage(id, page, lease);
      count++;
    }
    await catalog.finishProcessing(id, lease);
    return { pageCount: count };
  };
}
