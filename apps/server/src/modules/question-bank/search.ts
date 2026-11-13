import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import {
  bankCandidateSchema,
  bankSearchQuerySchema,
  type BankCandidate,
  type BankSearchQueryInput,
} from "../../../../../packages/contracts/src/question-bank.js";
import type { Database } from "../../../../../packages/db/src/client.js";

type CandidateRow = {
  entry_id: string;
  question_version_id: string;
  skill_id: string;
  difficulty_band: string;
  complexity_band: number;
  answer_type: string;
  template_family: string | null;
  matched_cause_count: string;
  seen_count: string;
};

export async function searchEligibleQuestions(
  db: Database,
  scope: StudentScope,
  query: BankSearchQueryInput,
): Promise<BankCandidate[]> {
  const parsed = bankSearchQuerySchema.parse(query);
  const rows = (
    await db.pool.query<CandidateRow>(
      `SELECT e.id AS entry_id,
              e.question_version_id,
              l.skill_id,
              e.difficulty_band,
              e.complexity_band,
              COALESCE((
                SELECT qr.answer_type FROM question_references qr
                WHERE qr.question_version_id = e.question_version_id
                ORDER BY qr.created_at DESC, qr.id
                LIMIT 1
              ), 'unknown') AS answer_type,
              e.template_family,
              (
                SELECT count(*) FROM error_diagnoses d
                WHERE d.question_version_id = e.question_version_id
                  AND d.status = 'confirmed'
                  AND d.invalidated_at IS NULL
                  AND EXISTS (
                    SELECT 1 FROM attempts a
                    WHERE a.id = d.attempt_id AND a.student_id = $2::uuid
                  )
              ) AS matched_cause_count,
              (
                SELECT count(*) FROM attempts a2
                WHERE a2.student_id = $2::uuid
                  AND a2.question_version_id = e.question_version_id
              ) AS seen_count
         FROM question_bank_entries e
         JOIN question_skill_links l
           ON l.entry_id = e.id AND l.is_primary
        WHERE e.status = 'published'
          AND l.skill_id = $1::uuid
          AND (e.visibility = 'shared' OR e.owner_id = $2::uuid)
          AND ($3::text IS NULL OR e.difficulty_band = $3::text)
          AND NOT (e.question_version_id = ANY($4::uuid[]))
          AND EXISTS (
            SELECT 1 FROM skill_content_links scl
            JOIN knowledge_items ki ON ki.id = scl.knowledge_item_id
            WHERE scl.skill_id = l.skill_id AND ki.status = 'published'
          )
          AND NOT EXISTS (
            SELECT 1 FROM skill_prerequisites sp
            WHERE sp.skill_id = l.skill_id
              AND NOT EXISTS (
                SELECT 1 FROM skill_content_links scl2
                JOIN knowledge_items ki2 ON ki2.id = scl2.knowledge_item_id
                WHERE scl2.skill_id = sp.prerequisite_id
                  AND ki2.status = 'published'
              )
          )
        ORDER BY seen_count ASC, matched_cause_count DESC, e.created_at, e.id
        LIMIT $5::int`,
      [
        parsed.skillId,
        scope.studentId,
        parsed.difficulty ?? null,
        parsed.excludeVersionIds ?? [],
        parsed.limit,
      ],
    )
  ).rows;
  const candidates = rows
    .map((row) => ({
      entryId: row.entry_id,
      questionVersionId: row.question_version_id,
      skillId: row.skill_id,
      difficulty: row.difficulty_band,
      complexityBand: row.complexity_band,
      answerType: row.answer_type,
      templateFamily: row.template_family,
      matchedCauseCount: Number(row.matched_cause_count),
      seenCount: Number(row.seen_count),
    }))
    .filter(
      (row) => !parsed.answerType || row.answerType === parsed.answerType,
    );
  return candidates.map((row) => bankCandidateSchema.parse(row));
}
