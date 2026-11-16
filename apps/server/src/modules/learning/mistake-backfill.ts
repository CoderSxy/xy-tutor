import { z } from "zod";
import type { Database } from "../../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import type { MistakeService } from "./mistakes.js";

export type BackfillScopeFilter = { studentId?: string };
export type BackfillOptions = {
  apply?: boolean;
  cursor?: string;
  batchSize?: number;
};

export type BackfillItem = {
  assessmentId: string;
  attemptId: string;
  studentId: string;
  status: "eligible" | "inserted" | "skipped";
  reasonCode?: "INVALID_EVIDENCE" | "NOT_AUTHORIZED" | "APPLY_FAILED";
};

export type BackfillReport = {
  scanned: number;
  eligible: number;
  inserted: number;
  skipped: number;
  nextCursor: string | null;
  items: BackfillItem[];
};

type CandidateRow = {
  assessmentId: string;
  attemptId: string;
  studentId: string;
  createdAt: string;
  invalidEvidence: boolean;
  authorized: boolean;
};

const batchSizeSchema = z.number().int().min(1).max(500);

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(
  cursor: string | undefined,
): [string | null, string | null] {
  if (!cursor) return [null, null];
  try {
    const parsed = z
      .tuple([z.string().min(1), z.uuid()])
      .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return [parsed[0], parsed[1]];
  } catch {
    throw Error("INVALID_CURSOR");
  }
}

async function ownerUserId(
  db: Database,
  studentId: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (cache.has(studentId)) return cache.get(studentId)!;
  const row = (
    await db.pool.query(
      "SELECT user_id FROM student_access WHERE student_id=$1 AND permission='owner' ORDER BY user_id LIMIT 1",
      [studentId],
    )
  ).rows[0];
  const owner = (row?.user_id as string | undefined) ?? null;
  cache.set(studentId, owner);
  return owner;
}

/**
 * Replays historical verified incorrect assessments that never produced a
 * mistake body. Dry-run is the default; only `apply` writes. Each candidate is
 * replayed through MistakeService.applyAssessment so there is no second
 * grading/provenance implementation, and retries rely on the existing
 * (mistake_id, assessment_id) uniqueness instead of new bookkeeping.
 */
export async function backfillMistakes(
  db: Database,
  service: MistakeService,
  scopeFilter: BackfillScopeFilter,
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const studentId = scopeFilter.studentId
    ? z.uuid().parse(scopeFilter.studentId)
    : null;
  const batchSize = batchSizeSchema.parse(options.batchSize ?? 100);
  const [cursorAt, cursorId] = decodeCursor(options.cursor);
  const candidates = (
    await db.pool.query<CandidateRow>(
      `WITH latest AS (
         SELECT DISTINCT ON (s.attempt_id) s.id
         FROM assessments s
         ORDER BY s.attempt_id, s.created_at DESC, s.id DESC
       )
       SELECT s.id AS "assessmentId",
              s.attempt_id AS "attemptId",
              a.student_id AS "studentId",
              s.created_at::text AS "createdAt",
              EXISTS(
                SELECT 1 FROM evidence_invalidations e
                WHERE e.student_id=a.student_id
                  AND (
                    e.evidence_version_id=a.question_version_id OR
                    (a.message_version_id IS NOT NULL AND e.evidence_version_id=a.message_version_id)
                  )
              ) AS "invalidEvidence",
              (
                q.student_id=a.student_id OR (
                  q.student_id IS NULL
                  AND a.task_id IS NOT NULL
                  AND EXISTS(
                    SELECT 1 FROM learning_tasks t
                    WHERE t.id=a.task_id AND t.student_id=a.student_id
                  )
                  AND EXISTS(
                    SELECT 1 FROM task_items ti
                    WHERE ti.task_id=a.task_id AND ti.question_version_id=a.question_version_id
                  )
                  AND EXISTS(
                    SELECT 1 FROM question_bank_entries e
                    WHERE e.question_version_id=a.question_version_id
                      AND e.status='published' AND e.visibility='shared'
                  )
                )
              ) AS "authorized"
       FROM assessments s
       JOIN latest l ON l.id=s.id
       JOIN attempts a ON a.id=s.attempt_id
       JOIN question_versions v ON v.id=a.question_version_id
       JOIN questions q ON q.id=v.question_id
       LEFT JOIN question_relations rel ON rel.variant_question_id=v.question_id
       WHERE s.verification='verified' AND s.correctness='incorrect'
         AND ($1::uuid IS NULL OR a.student_id=$1)
         AND (
           $2::timestamptz IS NULL OR
           (s.created_at, s.id) > ($2::timestamptz, $3::uuid)
         )
         AND NOT EXISTS(
           SELECT 1 FROM student_mistakes m
           WHERE m.student_id=a.student_id
             AND m.question_id=COALESCE(rel.origin_question_id,v.question_id)
         )
       ORDER BY s.created_at ASC, s.id ASC
       LIMIT $4`,
      [studentId, cursorAt, cursorId, batchSize],
    )
  ).rows;

  const owners = new Map<string, string | null>();
  const items: BackfillItem[] = [];
  let eligible = 0;
  let inserted = 0;
  const apply = options.apply === true;
  for (const row of candidates) {
    if (!row.authorized) {
      items.push({
        assessmentId: row.assessmentId,
        attemptId: row.attemptId,
        studentId: row.studentId,
        status: "skipped",
        reasonCode: "NOT_AUTHORIZED",
      });
      continue;
    }
    if (row.invalidEvidence) {
      items.push({
        assessmentId: row.assessmentId,
        attemptId: row.attemptId,
        studentId: row.studentId,
        status: "skipped",
        reasonCode: "INVALID_EVIDENCE",
      });
      continue;
    }
    eligible += 1;
    if (!apply) {
      items.push({
        assessmentId: row.assessmentId,
        attemptId: row.attemptId,
        studentId: row.studentId,
        status: "eligible",
      });
      continue;
    }
    const owner = await ownerUserId(db, row.studentId, owners);
    if (!owner) {
      items.push({
        assessmentId: row.assessmentId,
        attemptId: row.attemptId,
        studentId: row.studentId,
        status: "skipped",
        reasonCode: "NOT_AUTHORIZED",
      });
      continue;
    }
    const scope: StudentScope = {
      actor: { userId: owner, role: "student" },
      studentId: row.studentId,
    };
    try {
      await service.applyAssessment(scope, row.assessmentId);
      inserted += 1;
      items.push({
        assessmentId: row.assessmentId,
        attemptId: row.attemptId,
        studentId: row.studentId,
        status: "inserted",
      });
    } catch {
      items.push({
        assessmentId: row.assessmentId,
        attemptId: row.attemptId,
        studentId: row.studentId,
        status: "skipped",
        reasonCode: "APPLY_FAILED",
      });
    }
  }
  const last = candidates.at(-1);
  const skipped = items.filter((item) => item.status === "skipped").length;
  return {
    scanned: candidates.length,
    eligible,
    inserted,
    skipped,
    nextCursor:
      last && candidates.length === batchSize
        ? encodeCursor(last.createdAt, last.assessmentId)
        : null,
    items,
  };
}
