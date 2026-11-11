import type { KnowledgeSearchHit } from "../../../../../packages/contracts/src/knowledge-base.js";
import type { Database } from "../../../../../packages/db/src/client.js";

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function knowledgeSearchTerms(keywords: string): string[] {
  const phrase = keywords.trim();
  const terms = new Set<string>();
  if (phrase) terms.add(escapeLike(phrase));
  for (const segment of phrase.split(/[\s,，。！？、；;：:]+/)) {
    if (!segment || segment === phrase) continue;
    terms.add(escapeLike(segment));
    addHanWindows(terms, segment);
  }
  addHanWindows(terms, phrase);
  return [...terms].slice(0, 24);
}

function addHanWindows(terms: Set<string>, segment: string) {
  if (!/^[\p{Script=Han}]{4,}$/u.test(segment)) return;
  for (let size = Math.min(4, segment.length); size >= 2; size -= 1)
    for (let index = 0; index <= segment.length - size; index += 1) {
      terms.add(escapeLike(segment.slice(index, index + size)));
      if (terms.size >= 24) return;
    }
}

export async function searchPublishedKnowledge(
  db: Database,
  input: { keywords: string; limit?: number },
): Promise<KnowledgeSearchHit[]> {
  const terms = knowledgeSearchTerms(input.keywords);
  if (!terms.length) return [];
  const rows = await db.pool.query<KnowledgeSearchHit>(
    `SELECT id,title,summary FROM knowledge_items
     WHERE status='published'
       AND EXISTS (
         SELECT 1 FROM unnest($1::text[]) AS pattern
         WHERE title ILIKE '%' || pattern || '%' ESCAPE '\\'
            OR summary ILIKE '%' || pattern || '%' ESCAPE '\\'
       )
     ORDER BY (
         SELECT coalesce(max(char_length(pattern)), 0)
         FROM unnest($1::text[]) AS pattern
         WHERE title ILIKE '%' || pattern || '%' ESCAPE '\\'
       ) DESC,
       (
         SELECT coalesce(max(char_length(pattern)), 0)
         FROM unnest($1::text[]) AS pattern
         WHERE summary ILIKE '%' || pattern || '%' ESCAPE '\\'
       ) DESC,
       updated_at DESC,
       id DESC
     LIMIT $2`,
    [terms, input.limit ?? 5],
  );
  return rows.rows;
}
