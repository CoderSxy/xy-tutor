import type { KnowledgeSearchHit } from "../../../../../packages/contracts/src/knowledge-base.js";
import type { Database } from "../../../../../packages/db/src/client.js";

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function searchPublishedKnowledge(
  db: Database,
  input: { keywords: string; limit?: number },
): Promise<KnowledgeSearchHit[]> {
  const pattern = `%${escapeLike(input.keywords)}%`;
  const rows = await db.pool.query<KnowledgeSearchHit>(
    `SELECT id,title,summary FROM knowledge_items
     WHERE status='published'
       AND (title ILIKE $1 ESCAPE '\\' OR summary ILIKE $1 ESCAPE '\\')
     ORDER BY (title ILIKE $1 ESCAPE '\\') DESC, updated_at DESC, id DESC
     LIMIT $2`,
    [pattern, input.limit ?? 5],
  );
  return rows.rows;
}
