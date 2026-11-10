import type { PoolClient } from "pg";
import type { InsightFilter } from "../../../../../packages/contracts/src/student-insights.js";
import { resolveInsightRange } from "./metrics.js";

// 所有证据有效性判断共用同一口径：学生本人名下、原始题版本或消息版本未被失效。
export const VALID_ATTEMPT = `NOT EXISTS (
  SELECT 1 FROM evidence_invalidations i
  WHERE i.student_id = a.student_id
    AND (i.evidence_version_id = a.question_version_id
      OR i.evidence_version_id = a.message_version_id)
)`;

export const LATEST_ASSESSMENT = `LEFT JOIN LATERAL (
  SELECT s.id, s.correctness, s.verification, s.hint_dependency, s.created_at
  FROM assessments s
  WHERE s.attempt_id = a.id
  ORDER BY s.created_at DESC, s.id DESC
  LIMIT 1
) s ON true`;

export type FactAssessment = {
  id: string;
  correctness: string;
  verification: string;
  hintDependency: string;
};

export type FactAttempt = {
  id: string;
  taskId: string | null;
  questionId: string;
  questionVersionId: string;
  messageVersionId: string | null;
  revisionId: string;
  answer: string;
  createdAt: Date;
  hintCount: number;
  assessment: FactAssessment | null;
};

export type FactFirstAttempt = {
  attemptId: string;
  questionId: string;
  questionVersionId: string;
  revisionId: string;
  createdAt: Date;
  assessment: FactAssessment | null;
};

export type FactTask = {
  id: string;
  revisionId: string;
  kind: string;
  title: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

export type FactMistake = {
  id: string;
  questionId: string;
  status: string;
  originalAttemptId: string | null;
  createdAt: Date;
  dueAt: Date | null;
  consolidatedAt: Date | null;
};

export type FactKnowledgeObservation = {
  id: string;
  knowledgePoint: string;
  revisionId: string;
  assessmentId: string | null;
  fact: unknown;
  confidence: string;
  createdAt: Date;
};

export type FactMaterial = {
  id: string;
  revisionId: string;
  type: string;
  status: string;
  fileId: string;
  createdAt: Date;
};

export type FactQuestionSource = {
  questionVersionId: string;
  extractionId: string;
  materialId: string;
  pageId: string;
  bbox: unknown;
  teacherAnnotation: string | null;
};

export type FactLearningEvent = {
  id: string;
  eventType: string;
  sourceType: string;
  sourceId: string;
  taskId: string | null;
  revisionId: string | null;
  occurredAt: Date;
  sourceOrigin: string;
};

export type FactHint = {
  taskId: string;
  questionVersionId: string;
  level: string;
  displayedAt: Date;
};

export type InsightFacts = {
  range: { from: string; to: string };
  attempts: FactAttempt[];
  firstAttempts: FactFirstAttempt[];
  tasks: FactTask[];
  mistakes: FactMistake[];
  knowledge: FactKnowledgeObservation[];
  materials: FactMaterial[];
  questionSources: FactQuestionSource[];
  events: FactLearningEvent[];
  hints: FactHint[];
};

type AssessmentRow = {
  assessmentId: string | null;
  correctness: string | null;
  verification: string | null;
  hintDependency: string | null;
};

function assessmentOf(row: AssessmentRow): FactAssessment | null {
  if (!row.assessmentId || !row.correctness || !row.verification) return null;
  return {
    id: row.assessmentId,
    correctness: row.correctness,
    verification: row.verification,
    hintDependency: row.hintDependency ?? "none",
  };
}

export async function readInsightFacts(
  tx: PoolClient,
  studentId: string,
  filter: InsightFilter,
): Promise<InsightFacts> {
  const range = resolveInsightRange(filter);
  const params = [studentId, range.start, range.endExclusive];
  const revisionParam = filter.revisionId ?? null;
  const timeScoped = "a.created_at >= $2 AND a.created_at < $3";

  const attempts = await tx.query<
    AssessmentRow & {
      id: string;
      taskId: string | null;
      questionId: string;
      questionVersionId: string;
      messageVersionId: string | null;
      revisionId: string;
      answer: string;
      createdAt: Date;
      hintCount: number;
    }
  >(
    `SELECT a.id, a.task_id AS "taskId", v.question_id AS "questionId",
       a.question_version_id AS "questionVersionId",
       a.message_version_id AS "messageVersionId", q.revision_id AS "revisionId",
       a.answer, a.created_at AS "createdAt",
       s.id AS "assessmentId", s.correctness, s.verification,
       s.hint_dependency AS "hintDependency",
       (SELECT count(*)::int FROM hints h
         WHERE h.task_id = a.task_id
           AND h.question_version_id = a.question_version_id) AS "hintCount"
     FROM attempts a
     JOIN question_versions v ON v.id = a.question_version_id
     JOIN questions q ON q.id = v.question_id
     LEFT JOIN learning_tasks t ON t.id = a.task_id
     ${LATEST_ASSESSMENT}
     WHERE a.student_id = $1 AND ${timeScoped}
       AND (a.task_id IS NULL OR t.deleted_at IS NULL)
       AND ($4::uuid IS NULL OR q.revision_id = $4)
       AND ${VALID_ATTEMPT}
     ORDER BY a.created_at DESC, a.id`,
    [...params, revisionParam],
  );

  const firstAttempts = await tx.query<
    AssessmentRow & {
      attemptId: string;
      questionId: string;
      questionVersionId: string;
      revisionId: string;
      createdAt: Date;
    }
  >(
    `SELECT DISTINCT ON (v.question_id)
       a.id AS "attemptId", v.question_id AS "questionId",
       a.question_version_id AS "questionVersionId",
       q.revision_id AS "revisionId", a.created_at AS "createdAt",
       s.id AS "assessmentId", s.correctness, s.verification,
       s.hint_dependency AS "hintDependency"
     FROM attempts a
     JOIN question_versions v ON v.id = a.question_version_id
     JOIN questions q ON q.id = v.question_id
     LEFT JOIN learning_tasks t ON t.id = a.task_id
     ${LATEST_ASSESSMENT}
     WHERE a.student_id = $1
       AND (a.task_id IS NULL OR t.deleted_at IS NULL)
       AND ${VALID_ATTEMPT}
     ORDER BY v.question_id, a.created_at, a.id`,
    [studentId],
  );

  const tasks = await tx.query<FactTask>(
    `SELECT t.id, t.revision_id AS "revisionId", t.kind, t.title, t.status,
       t.created_at AS "createdAt", t.updated_at AS "updatedAt"
     FROM learning_tasks t
     WHERE t.student_id = $1 AND t.deleted_at IS NULL
       AND t.created_at >= $2 AND t.created_at < $3
       AND ($4::uuid IS NULL OR t.revision_id = $4)
     ORDER BY t.created_at, t.id`,
    [...params, revisionParam],
  );

  const mistakes = await tx.query<FactMistake>(
    `SELECT m.id, m.question_id AS "questionId", m.status,
       m.original_attempt_id AS "originalAttemptId",
       m.created_at AS "createdAt", m.due_at AS "dueAt",
       m.consolidated_at AS "consolidatedAt"
     FROM student_mistakes m
     JOIN questions q ON q.id = m.question_id
     WHERE m.student_id = $1
       AND ($2::uuid IS NULL OR q.revision_id = $2)
     ORDER BY m.created_at, m.id`,
    [studentId, revisionParam],
  );

  const knowledge = await tx.query<
    FactKnowledgeObservation & { assessmentId: string | null }
  >(
    `SELECT o.id, o.knowledge_point AS "knowledgePoint",
       o.revision_id AS "revisionId", o.assessment_id AS "assessmentId",
       o.fact, o.confidence, o.created_at AS "createdAt"
     FROM knowledge_observations o
     LEFT JOIN assessments s ON s.id = o.assessment_id
     LEFT JOIN attempts a ON a.id = s.attempt_id
     WHERE o.student_id = $1
       AND o.created_at >= $2 AND o.created_at < $3
       AND ($4::uuid IS NULL OR o.revision_id = $4)
       AND (
         o.assessment_id IS NULL
         OR (
           a.id IS NOT NULL
           AND ${VALID_ATTEMPT}
           AND NOT EXISTS (
             SELECT 1 FROM assessments newer
             WHERE newer.attempt_id = s.attempt_id
               AND (newer.created_at, newer.id) > (s.created_at, s.id)
           )
         )
       )
     ORDER BY o.created_at, o.id`,
    [...params, revisionParam],
  );

  const materials = await tx.query<FactMaterial>(
    `SELECT m.id, m.revision_id AS "revisionId", m.type, m.status,
       m.file_id AS "fileId", m.created_at AS "createdAt"
     FROM materials m
     WHERE m.student_id = $1
       AND m.created_at >= $2 AND m.created_at < $3
       AND ($4::uuid IS NULL OR m.revision_id = $4)
     ORDER BY m.created_at, m.id`,
    [...params, revisionParam],
  );

  const questionSources = await tx.query<FactQuestionSource>(
    `SELECT src.question_version_id AS "questionVersionId",
       src.extraction_id AS "extractionId", e.material_id AS "materialId",
       src.page_id AS "pageId", src.bbox,
       src.teacher_annotation AS "teacherAnnotation"
     FROM question_sources src
     JOIN extractions e ON e.id = src.extraction_id
     JOIN materials m ON m.id = e.material_id
     WHERE m.student_id = $1
       AND m.created_at >= $2 AND m.created_at < $3
     ORDER BY m.created_at, src.question_version_id`,
    params,
  );

  const events = await tx.query<FactLearningEvent>(
    `SELECT e.id, e.event_type AS "eventType", e.source_type AS "sourceType",
       e.source_id AS "sourceId", e.task_id AS "taskId",
       e.revision_id AS "revisionId", e.occurred_at AS "occurredAt",
       e.source_origin AS "sourceOrigin"
     FROM student_learning_events e
     LEFT JOIN learning_tasks t ON t.id = e.task_id
     WHERE e.student_id = $1
       AND e.occurred_at >= $2 AND e.occurred_at < $3
       AND (e.task_id IS NULL OR t.deleted_at IS NULL)
       AND ($4::uuid IS NULL OR e.revision_id = $4)
       AND CASE e.source_type
         WHEN 'attempt' THEN EXISTS(SELECT 1 FROM attempts x WHERE x.id = e.source_id)
         WHEN 'message' THEN EXISTS(SELECT 1 FROM messages x WHERE x.id = e.source_id)
         WHEN 'material' THEN EXISTS(SELECT 1 FROM materials x WHERE x.id = e.source_id)
         ELSE false
       END
     ORDER BY e.occurred_at, e.id`,
    [...params, revisionParam],
  );

  const hints = await tx.query<FactHint>(
    `SELECT h.task_id AS "taskId", h.question_version_id AS "questionVersionId",
       h.level, h.displayed_at AS "displayedAt"
     FROM hints h
     WHERE h.displayed_at >= $1 AND h.displayed_at < $2
       AND h.task_id IN (
         SELECT id FROM learning_tasks WHERE student_id = $3 AND deleted_at IS NULL
       )
     ORDER BY h.displayed_at, h.id`,
    [range.start, range.endExclusive, studentId],
  );

  return {
    range: { from: range.from, to: range.to },
    attempts: attempts.rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      questionId: row.questionId,
      questionVersionId: row.questionVersionId,
      messageVersionId: row.messageVersionId,
      revisionId: row.revisionId,
      answer: row.answer,
      createdAt: row.createdAt,
      hintCount: row.hintCount,
      assessment: assessmentOf(row),
    })),
    firstAttempts: firstAttempts.rows
      .map((row) => ({
        attemptId: row.attemptId,
        questionId: row.questionId,
        questionVersionId: row.questionVersionId,
        revisionId: row.revisionId,
        createdAt: row.createdAt,
        assessment: assessmentOf(row),
      }))
      .filter(
        (row) =>
          row.createdAt >= range.start &&
          row.createdAt < range.endExclusive &&
          (!filter.revisionId || row.revisionId === filter.revisionId),
      ),
    tasks: tasks.rows,
    mistakes: mistakes.rows,
    knowledge: knowledge.rows.map((row) => ({
      id: row.id,
      knowledgePoint: row.knowledgePoint,
      revisionId: row.revisionId,
      assessmentId: row.assessmentId,
      fact: row.fact,
      confidence: row.confidence,
      createdAt: row.createdAt,
    })),
    materials: materials.rows,
    questionSources: questionSources.rows,
    events: events.rows,
    hints: hints.rows,
  };
}
