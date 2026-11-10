import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb, inTransaction, type Database } from "../packages/db/src/client.js";
import { createFileStore, type FileStore } from "../apps/server/src/infra/oss.js";

const RETENTION_HOURS = 24;
const BATCH_SIZE = 200;
const CANDIDATE_STATUSES = [
  "prepared",
  "ready",
  "rejected",
  "cleanup_failed",
  "deleting",
];

export type CleanupResult = {
  eligible: number;
  cleaned: number;
  failed: number;
  skipped: number;
};

type CleanupRow = {
  id: string;
  object_key: string;
  source_key: string | null;
  sealed_key: string | null;
};

const sealedKeyFor = (sourceKey: string) =>
  `sealed/${createHash("sha256").update(sourceKey).digest("hex")}`;

function candidateKeys(row: CleanupRow): string[] {
  const keys = new Set<string>();
  if (row.source_key) {
    keys.add(row.source_key);
    keys.add(sealedKeyFor(row.source_key));
  }
  if (row.sealed_key) keys.add(row.sealed_key);
  if (row.object_key) keys.add(row.object_key);
  return [...keys];
}

function isMissingObject(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  const status = (error as { status?: number } | null)?.status;
  return code === "NoSuchKey" || code === "NotFound" || status === 404;
}

const CLAIMABLE = `purpose='conversation_image'
  AND status = ANY($2::text[])
  AND created_at < $3
  AND NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.file_id = files.id)`;

export async function cleanupChatImages(input: {
  db: Database;
  store: FileStore;
  execute: boolean;
  now?: Date;
  batchSize?: number;
}): Promise<CleanupResult> {
  const { db, store, execute } = input;
  const cutoff = new Date(
    (input.now ?? new Date()).getTime() - RETENTION_HOURS * 3_600_000,
  );
  const limit = input.batchSize ?? BATCH_SIZE;
  const candidates = (
    await db.pool.query<{ id: string }>(
      `SELECT id FROM files WHERE ${CLAIMABLE} ORDER BY created_at LIMIT $1`,
      [limit, CANDIDATE_STATUSES, cutoff],
    )
  ).rows;
  const result: CleanupResult = {
    eligible: candidates.length,
    cleaned: 0,
    failed: 0,
    skipped: 0,
  };
  if (!execute) return result;
  for (const candidate of candidates) {
    const claimed = await inTransaction(db, async (tx) => {
      const row = (
        await tx.query<CleanupRow>(
          `SELECT id,object_key,source_key,sealed_key FROM files WHERE id=$1 AND ${CLAIMABLE} FOR UPDATE SKIP LOCKED`,
          [candidate.id, CANDIDATE_STATUSES, cutoff],
        )
      ).rows[0];
      if (!row) return undefined;
      await tx.query(
        "UPDATE files SET status='deleting',cleanup_error=NULL WHERE id=$1",
        [row.id],
      );
      return row;
    });
    if (!claimed) {
      result.skipped += 1;
      continue;
    }
    try {
      for (const key of candidateKeys(claimed)) {
        try {
          await store.delete(key);
        } catch (error) {
          if (!isMissingObject(error)) throw error;
        }
      }
      await db.pool.query(
        "UPDATE files SET status='deleted',cleanup_error=NULL WHERE id=$1 AND status='deleting'",
        [claimed.id],
      );
      result.cleaned += 1;
    } catch (error) {
      await db.pool.query(
        "UPDATE files SET status='cleanup_failed',cleanup_error=$2 WHERE id=$1 AND status='deleting'",
        [
          claimed.id,
          String((error as Error)?.message ?? error).slice(0, 500),
        ],
      );
      result.failed += 1;
    }
  }
  return result;
}

async function main() {
  const execute = process.argv.includes("--execute");
  if (!process.env.DATABASE_URL)
    throw Error("Set DATABASE_URL before running cleanup:chat-images");
  const store = createFileStore(process.env);
  if (!store) throw Error("Set OSS_* credentials before running cleanup:chat-images");
  const db = createDb(process.env.DATABASE_URL);
  try {
    const result = await cleanupChatImages({ db, store, execute });
    console.log(
      `${execute ? "cleanup" : "dry-run"}: eligible=${result.eligible} cleaned=${result.cleaned} failed=${result.failed} skipped=${result.skipped}`,
    );
    if (!execute)
      console.log("No objects deleted. Re-run with --execute to delete.");
  } finally {
    await db.close();
  }
}

const script = process.argv[1];
if (
  script &&
  realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))
)
  await main();
