import type { PoolClient } from "pg";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type {
  AdminInsightScope,
  AttemptRecordDTO,
  InsightPage,
  MaterialExtractionDTO,
  MaterialListQuery,
  MaterialQuestionDTO,
  MaterialRecordDTO,
  MessageRecordDTO,
  MistakeEventDTO,
  MistakeListQuery,
  MistakeRecordDTO,
  PageQuery,
  TaskItemDTO,
  TaskListQuery,
  TaskRecordDTO,
} from "../../../../../packages/contracts/src/student-insights.js";
import type { Database } from "../../../../../packages/db/src/client.js";
import { LATEST_ASSESSMENT, VALID_ATTEMPT } from "./facts.js";
import { resolveInsightRange, type ResolvedRange } from "./metrics.js";
import { auditInsight } from "./policy.js";
import { metaFor, readCoverage } from "./queries.js";

const TASK_WHERE = `t.student_id = $1 AND t.deleted_at IS NULL
  AND t.created_at >= $2 AND t.created_at < $3
  AND ($4::uuid IS NULL OR t.revision_id = $4)
  AND ($5::text IS NULL OR t.status = $5)
  AND ($6::text IS NULL OR t.kind = $6)`;

const MISTAKE_WHERE = `m.student_id = $1
  AND m.created_at >= $2 AND m.created_at < $3
  AND ($4::uuid IS NULL OR q.revision_id = $4)
  AND ($5::text IS NULL OR m.status = $5)
  AND ($6::text IS NULL OR v.knowledge_point = $6)
  AND ($7::uuid IS NULL OR EXISTS (
    SELECT 1
    FROM attempts a
    JOIN learning_tasks t ON t.id = a.task_id
    JOIN question_versions qv ON qv.id = a.question_version_id
    WHERE a.student_id = m.student_id
      AND qv.question_id = m.question_id
      AND t.chapter_id = $7
      AND t.deleted_at IS NULL
  ))`;

const MATERIAL_WHERE = `m.student_id = $1
  AND m.created_at >= $2 AND m.created_at < $3
  AND ($4::uuid IS NULL OR m.revision_id = $4)
  AND ($5::text[] IS NULL OR m.type = ANY($5::text[]))
  AND ($6::text IS NULL OR m.status = $6)`;

const MISTAKE_FROM = `FROM student_mistakes m
  JOIN questions q ON q.id = m.question_id
  JOIN LATERAL (
    SELECT qv.stem, qv.knowledge_point
    FROM question_versions qv
    WHERE qv.question_id = m.question_id
    ORDER BY qv.version_no DESC, qv.created_at DESC
    LIMIT 1
  ) v ON true`;

const MATERIAL_FROM = `FROM materials m
  JOIN files f ON f.id = m.file_id`;

type Correctness = AttemptRecordDTO["assessment"] extends null
  ? never
  : NonNullable<AttemptRecordDTO["assessment"]>["correctness"];

type TaskRow = {
  id: string;
  kind: string;
  title: string | null;
  status: string;
  revisionId: string;
  chapterId: string | null;
  createdAt: Date;
  updatedAt: Date;
  itemCount: number;
  answeredCount: number;
};

type TaskItemRow = {
  id: string;
  questionId: string;
  questionVersionId: string;
  position: number;
  role: string;
  status: string;
  stem: string;
  knowledgePoint: string | null;
};

type AttemptRow = {
  id: string;
  taskId: string | null;
  questionId: string;
  questionVersionId: string;
  messageVersionId: string | null;
  answer: string;
  createdAt: Date;
  stem: string;
  knowledgePoint: string | null;
  hints: { level: string; content: string }[];
  assessmentId: string | null;
  correctness: string | null;
  verification: string | null;
  hintDependency: string | null;
};

type MessageRow = {
  id: string;
  role: string;
  versionId: string;
  versionNo: number;
  content: string;
  createdAt: Date;
  attachments: { fileId: string; name: string; contentType: string }[];
};

type MistakeRow = {
  id: string;
  questionId: string;
  status: string;
  createdAt: Date;
  dueAt: Date | null;
  stem: string;
  knowledgePoint: string | null;
  revisionId: string;
};

type MistakeEventRow = {
  id: string;
  type: string;
  fromState: string;
  toState: string;
  reason: string;
  evidenceAt: Date;
  attemptId: string | null;
  assessmentId: string | null;
  createdAt: Date;
};

type MaterialRow = {
  id: string;
  fileId: string;
  name: string;
  contentType: string;
  type: string;
  status: string;
  revisionId: string;
  createdAt: Date;
  questionIds: string[];
};

type MaterialQuestionRow = {
  questionId: string;
  questionVersionId: string;
  stem: string;
  knowledgePoint: string | null;
};

type ExtractionRow = {
  id: string;
  versionNo: number;
  model: string;
  promptVersion: string;
  createdAt: Date;
};

type RangeParams = {
  range: ResolvedRange;
  revisionId: string | null;
};

function notFound(message = "记录不存在"): AppError {
  return new AppError("NOT_FOUND", 404, message);
}

function paramsOf(input: {
  from?: string;
  to?: string;
  revisionId?: string;
}): RangeParams {
  const range = resolveInsightRange(input);
  return { range, revisionId: input.revisionId ?? null };
}

function rangeParams({ range, revisionId }: RangeParams): unknown[] {
  return [range.start, range.endExclusive, revisionId];
}

function toTask(row: TaskRow): TaskRecordDTO {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    revisionId: row.revisionId,
    chapterId: row.chapterId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    itemCount: row.itemCount,
    answeredCount: row.answeredCount,
  };
}

function toTaskItem(row: TaskItemRow): TaskItemDTO {
  return {
    id: row.id,
    questionId: row.questionId,
    questionVersionId: row.questionVersionId,
    position: row.position,
    role: row.role,
    status: row.status,
    stem: row.stem,
    knowledgePoint: row.knowledgePoint,
  };
}

function toAttempt(row: AttemptRow): AttemptRecordDTO {
  return {
    id: row.id,
    taskId: row.taskId,
    questionId: row.questionId,
    questionVersionId: row.questionVersionId,
    messageVersionId: row.messageVersionId,
    answer: row.answer,
    createdAt: row.createdAt.toISOString(),
    stem: row.stem,
    knowledgePoint: row.knowledgePoint,
    hints: row.hints ?? [],
    assessment:
      row.assessmentId && row.correctness && row.verification
        ? {
            id: row.assessmentId,
            correctness: row.correctness as Correctness,
            verification: row.verification,
            hintDependency: row.hintDependency ?? "none",
            feedback: null,
          }
        : null,
  };
}

function toMessage(row: MessageRow): MessageRecordDTO {
  return {
    id: row.id,
    role: row.role,
    versionId: row.versionId,
    versionNo: row.versionNo,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    attachments: row.attachments ?? [],
  };
}

function toMistake(row: MistakeRow): MistakeRecordDTO {
  return {
    id: row.id,
    questionId: row.questionId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    dueAt: row.dueAt?.toISOString() ?? null,
    stem: row.stem,
    knowledgePoint: row.knowledgePoint,
    revisionId: row.revisionId,
  };
}

function toMistakeEvent(row: MistakeEventRow): MistakeEventDTO {
  return {
    id: row.id,
    type: row.type,
    fromState: row.fromState,
    toState: row.toState,
    reason: row.reason,
    evidenceAt: row.evidenceAt.toISOString(),
    attemptId: row.attemptId,
    assessmentId: row.assessmentId,
    createdAt: row.createdAt.toISOString(),
  };
}

export class InsightRecordService {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async read<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async audited<T>(
    scope: AdminInsightScope,
    action: string,
    details: Record<string, unknown>,
    fn: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await auditInsight(client, scope, action, details);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async meta(
    tx: PoolClient,
    range: ResolvedRange,
  ): Promise<ReturnType<typeof metaFor>> {
    const now = this.now();
    const filter = { from: range.from, to: range.to };
    const coverage = await readCoverage(tx, filter);
    return metaFor(filter, now, coverage);
  }

  async listTasks(
    scope: AdminInsightScope,
    input: TaskListQuery,
  ): Promise<InsightPage<TaskRecordDTO>> {
    const params = paramsOf(input);
    return this.read(async (tx) => {
      const values = [
        scope.studentId,
        ...rangeParams(params),
        input.status ?? null,
        input.kind ?? null,
      ];
      const total = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM learning_tasks t WHERE ${TASK_WHERE}`,
        values,
      );
      const rows = await tx.query<TaskRow>(
        `SELECT t.id, t.kind, t.title, t.status,
           t.revision_id AS "revisionId", t.chapter_id AS "chapterId",
           t.created_at AS "createdAt", t.updated_at AS "updatedAt",
           (SELECT count(*)::int FROM task_items ti
             WHERE ti.task_id = t.id) AS "itemCount",
           (SELECT count(DISTINCT ti.question_version_id)::int
             FROM task_items ti
             WHERE ti.task_id = t.id
               AND EXISTS (
                 SELECT 1 FROM attempts a
                 WHERE a.task_id = t.id
                   AND a.student_id = t.student_id
                   AND a.question_version_id = ti.question_version_id
               )) AS "answeredCount"
         FROM learning_tasks t
         WHERE ${TASK_WHERE}
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT $7 OFFSET $8`,
        [...values, input.limit, input.offset],
      );
      const meta = await this.meta(tx, params.range);
      return {
        items: rows.rows.map(toTask),
        total: total.rows[0]!.n,
        meta,
      };
    });
  }

  async getTask(
    scope: AdminInsightScope,
    taskId: string,
    page: PageQuery,
    requestId?: string,
  ): Promise<{ task: TaskRecordDTO; items: InsightPage<TaskItemDTO> }> {
    return this.audited(
      scope,
      "student_insight.task_view",
      { taskId, requestId },
      async (tx) => {
        const task = await tx.query<TaskRow>(
          `SELECT t.id, t.kind, t.title, t.status,
             t.revision_id AS "revisionId", t.chapter_id AS "chapterId",
             t.created_at AS "createdAt", t.updated_at AS "updatedAt",
             (SELECT count(*)::int FROM task_items ti
               WHERE ti.task_id = t.id) AS "itemCount",
             (SELECT count(DISTINCT ti.question_version_id)::int
               FROM task_items ti
               WHERE ti.task_id = t.id
                 AND EXISTS (
                   SELECT 1 FROM attempts a
                   WHERE a.task_id = t.id
                     AND a.student_id = t.student_id
                     AND a.question_version_id = ti.question_version_id
                 )) AS "answeredCount"
           FROM learning_tasks t
           WHERE t.id = $1 AND t.student_id = $2 AND t.deleted_at IS NULL`,
          [taskId, scope.studentId],
        );
        const row = task.rows[0];
        if (!row) throw notFound("任务不存在");

        const total = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n
           FROM task_items ti
           JOIN question_versions v ON v.id = ti.question_version_id
           JOIN questions q ON q.id = v.question_id
           WHERE ti.task_id = $1 AND q.student_id = $2`,
          [taskId, scope.studentId],
        );
        const items = await tx.query<TaskItemRow>(
          `SELECT ti.id, v.question_id AS "questionId",
             ti.question_version_id AS "questionVersionId", ti.position,
             ti.role, ti.status, v.stem,
             v.knowledge_point AS "knowledgePoint"
           FROM task_items ti
           JOIN question_versions v ON v.id = ti.question_version_id
           JOIN questions q ON q.id = v.question_id
           WHERE ti.task_id = $1 AND q.student_id = $2
           ORDER BY ti.position, ti.id
           LIMIT $3 OFFSET $4`,
          [taskId, scope.studentId, page.limit, page.offset],
        );
        const range = resolveInsightRange({}, this.now());
        return {
          task: toTask(row),
          items: {
            items: items.rows.map(toTaskItem),
            total: total.rows[0]!.n,
            meta: await this.meta(tx, range),
          },
        };
      },
    );
  }

  async listAttempts(
    scope: AdminInsightScope,
    taskId: string,
    page: PageQuery,
  ): Promise<InsightPage<AttemptRecordDTO>> {
    const range = resolveInsightRange({}, this.now());
    return this.read(async (tx) => {
      await this.requireTask(tx, scope, taskId);
      const total = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n
         FROM attempts a
         JOIN question_versions v ON v.id = a.question_version_id
         LEFT JOIN learning_tasks t ON t.id = a.task_id
         WHERE a.student_id = $1 AND a.task_id = $2
           AND (a.task_id IS NULL OR t.deleted_at IS NULL)
           AND ${VALID_ATTEMPT}`,
        [scope.studentId, taskId],
      );
      const rows = await tx.query<AttemptRow>(
        `SELECT a.id, a.task_id AS "taskId", v.question_id AS "questionId",
           a.question_version_id AS "questionVersionId",
           a.message_version_id AS "messageVersionId", a.answer,
           a.created_at AS "createdAt", v.stem,
           v.knowledge_point AS "knowledgePoint",
           s.id AS "assessmentId", s.correctness, s.verification,
           s.hint_dependency AS "hintDependency",
           COALESCE((
             SELECT json_agg(
               json_build_object('level', h.level, 'content', mv.content)
               ORDER BY h.displayed_at, h.id
             )
             FROM hints h
             JOIN message_versions mv ON mv.id = h.message_version_id
             JOIN messages hm ON hm.id = mv.message_id
               AND hm.current_version = mv.version_no
             WHERE h.task_id = a.task_id
               AND h.question_version_id = a.question_version_id
               AND h.displayed_at <= a.created_at
               AND NOT EXISTS (
                 SELECT 1 FROM evidence_invalidations i
                 WHERE i.student_id = a.student_id
                   AND i.evidence_version_id = mv.id
               )
           ), '[]'::json) AS hints
         FROM attempts a
         JOIN question_versions v ON v.id = a.question_version_id
         LEFT JOIN learning_tasks t ON t.id = a.task_id
         ${LATEST_ASSESSMENT}
         WHERE a.student_id = $1 AND a.task_id = $2
           AND (a.task_id IS NULL OR t.deleted_at IS NULL)
           AND ${VALID_ATTEMPT}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT $3 OFFSET $4`,
        [scope.studentId, taskId, page.limit, page.offset],
      );
      return {
        items: rows.rows.map(toAttempt),
        total: total.rows[0]!.n,
        meta: await this.meta(tx, range),
      };
    });
  }

  async listMessages(
    scope: AdminInsightScope,
    conversationId: string,
    page: PageQuery,
  ): Promise<InsightPage<MessageRecordDTO>> {
    const range = resolveInsightRange({}, this.now());
    return this.read(async (tx) => {
      const conversation = await tx.query(
        `SELECT 1
         FROM conversations c
         LEFT JOIN learning_tasks t ON t.id = c.task_id
         WHERE c.id = $1 AND c.student_id = $2
           AND (c.task_id IS NULL OR t.deleted_at IS NULL)`,
        [conversationId, scope.studentId],
      );
      if (!conversation.rowCount) throw notFound("对话不存在");

      const total = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n
         FROM messages m
         JOIN message_versions mv ON mv.message_id = m.id
           AND mv.version_no = m.current_version
         JOIN conversations c ON c.id = m.conversation_id
         WHERE c.id = $1 AND c.student_id = $2
           AND NOT EXISTS (
             SELECT 1 FROM evidence_invalidations i
             WHERE i.student_id = c.student_id
               AND i.evidence_version_id = mv.id
           )`,
        [conversationId, scope.studentId],
      );
      const rows = await tx.query<MessageRow>(
        `SELECT m.id, m.role, mv.id AS "versionId",
           mv.version_no AS "versionNo", mv.content,
           mv.created_at AS "createdAt",
           COALESCE((
             SELECT json_agg(
               json_build_object(
                 'fileId', f.id, 'name', f.name,
                 'contentType', f.content_type
               )
               ORDER BY ma.position
             )
             FROM message_attachments ma
             JOIN files f ON f.id = ma.file_id
             WHERE ma.message_version_id = mv.id AND f.status = 'ready'
           ), '[]'::json) AS attachments
         FROM messages m
         JOIN message_versions mv ON mv.message_id = m.id
           AND mv.version_no = m.current_version
         JOIN conversations c ON c.id = m.conversation_id
         WHERE c.id = $1 AND c.student_id = $2
           AND NOT EXISTS (
             SELECT 1 FROM evidence_invalidations i
             WHERE i.student_id = c.student_id
               AND i.evidence_version_id = mv.id
           )
         ORDER BY mv.created_at, m.id
         LIMIT $3 OFFSET $4`,
        [conversationId, scope.studentId, page.limit, page.offset],
      );
      return {
        items: rows.rows.map(toMessage),
        total: total.rows[0]!.n,
        meta: await this.meta(tx, range),
      };
    });
  }

  async listMistakes(
    scope: AdminInsightScope,
    input: MistakeListQuery,
  ): Promise<InsightPage<MistakeRecordDTO>> {
    const params = paramsOf(input);
    return this.read(async (tx) => {
      const values = [
        scope.studentId,
        ...rangeParams(params),
        input.status ?? null,
        input.knowledgePoint ?? null,
        input.chapterId ?? null,
      ];
      const total = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n ${MISTAKE_FROM} WHERE ${MISTAKE_WHERE}`,
        values,
      );
      const rows = await tx.query<MistakeRow>(
        `SELECT m.id, m.question_id AS "questionId", m.status,
           m.created_at AS "createdAt", m.due_at AS "dueAt",
           v.stem, v.knowledge_point AS "knowledgePoint",
           q.revision_id AS "revisionId"
         ${MISTAKE_FROM}
         WHERE ${MISTAKE_WHERE}
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT $8 OFFSET $9`,
        [...values, input.limit, input.offset],
      );
      return {
        items: rows.rows.map(toMistake),
        total: total.rows[0]!.n,
        meta: await this.meta(tx, params.range),
      };
    });
  }

  async getMistake(
    scope: AdminInsightScope,
    mistakeId: string,
    requestId?: string,
  ): Promise<{ mistake: MistakeRecordDTO; recentEvents: MistakeEventDTO[] }> {
    return this.audited(
      scope,
      "student_insight.mistake_view",
      { mistakeId, requestId },
      async (tx) => {
        const rows = await tx.query<MistakeRow>(
          `SELECT m.id, m.question_id AS "questionId", m.status,
             m.created_at AS "createdAt", m.due_at AS "dueAt",
             v.stem, v.knowledge_point AS "knowledgePoint",
             q.revision_id AS "revisionId"
           ${MISTAKE_FROM}
           WHERE m.id = $1 AND m.student_id = $2`,
          [mistakeId, scope.studentId],
        );
        const row = rows.rows[0];
        if (!row) throw notFound("错题不存在");
        const events = await tx.query<MistakeEventRow>(
          `SELECT id, type, from_state AS "fromState",
             to_state AS "toState", reason,
             evidence_at AS "evidenceAt", attempt_id AS "attemptId",
             assessment_id AS "assessmentId", created_at AS "createdAt"
           FROM mistake_state_events
           WHERE mistake_id = $1
           ORDER BY evidence_at DESC, sequence DESC
           LIMIT 5`,
          [mistakeId],
        );
        return {
          mistake: toMistake(row),
          recentEvents: events.rows.map(toMistakeEvent),
        };
      },
    );
  }

  async listMistakeEvents(
    scope: AdminInsightScope,
    mistakeId: string,
    page: PageQuery,
  ): Promise<InsightPage<MistakeEventDTO>> {
    const range = resolveInsightRange({}, this.now());
    return this.read(async (tx) => {
      await this.requireMistake(tx, scope, mistakeId);
      const total = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n
         FROM mistake_state_events WHERE mistake_id = $1`,
        [mistakeId],
      );
      const rows = await tx.query<MistakeEventRow>(
        `SELECT id, type, from_state AS "fromState",
           to_state AS "toState", reason,
           evidence_at AS "evidenceAt", attempt_id AS "attemptId",
           assessment_id AS "assessmentId", created_at AS "createdAt"
         FROM mistake_state_events
         WHERE mistake_id = $1
         ORDER BY evidence_at DESC, sequence DESC
         LIMIT $2 OFFSET $3`,
        [mistakeId, page.limit, page.offset],
      );
      return {
        items: rows.rows.map(toMistakeEvent),
        total: total.rows[0]!.n,
        meta: await this.meta(tx, range),
      };
    });
  }

  async listMaterials(
    scope: AdminInsightScope,
    input: MaterialListQuery,
  ): Promise<InsightPage<MaterialRecordDTO>> {
    const params = paramsOf(input);
    return this.read(async (tx) => {
      const values = [
        scope.studentId,
        ...rangeParams(params),
        input.types ?? null,
        input.status ?? null,
      ];
      const total = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n ${MATERIAL_FROM} WHERE ${MATERIAL_WHERE}`,
        values,
      );
      const rows = await tx.query<MaterialRow>(
        `SELECT m.id, m.file_id AS "fileId", f.name,
           f.content_type AS "contentType", m.type, m.status,
           m.revision_id AS "revisionId", m.created_at AS "createdAt",
           COALESCE((
             SELECT array_agg(DISTINCT qv.question_id)
             FROM extractions e
             JOIN question_sources src ON src.extraction_id = e.id
             JOIN question_versions qv ON qv.id = src.question_version_id
             WHERE e.material_id = m.id
           ), '{}') AS "questionIds"
         ${MATERIAL_FROM}
         WHERE ${MATERIAL_WHERE}
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT $7 OFFSET $8`,
        [...values, input.limit, input.offset],
      );
      const flags = await readQuestionFlags(
        tx,
        scope.studentId,
        rows.rows.flatMap((row) => row.questionIds ?? []),
      );
      return {
        items: rows.rows.map((row) => materialOf(row, flags)),
        total: total.rows[0]!.n,
        meta: await this.meta(tx, params.range),
      };
    });
  }

  async getMaterial(
    scope: AdminInsightScope,
    materialId: string,
    requestId?: string,
  ): Promise<{
    material: MaterialRecordDTO;
    extraction: MaterialExtractionDTO | null;
  }> {
    return this.audited(
      scope,
      "student_insight.material_view",
      { materialId, requestId },
      async (tx) => {
        const rows = await tx.query<MaterialRow>(
          `SELECT m.id, m.file_id AS "fileId", f.name,
             f.content_type AS "contentType", m.type, m.status,
             m.revision_id AS "revisionId", m.created_at AS "createdAt",
             COALESCE((
               SELECT array_agg(DISTINCT qv.question_id)
               FROM extractions e
               JOIN question_sources src ON src.extraction_id = e.id
               JOIN question_versions qv ON qv.id = src.question_version_id
               WHERE e.material_id = m.id
             ), '{}') AS "questionIds"
           ${MATERIAL_FROM}
           WHERE m.id = $1 AND m.student_id = $2`,
          [materialId, scope.studentId],
        );
        const row = rows.rows[0];
        if (!row) throw notFound("资料不存在");
        const extraction = await tx.query<ExtractionRow>(
          `SELECT id, version_no AS "versionNo", model,
             prompt_version AS "promptVersion", created_at AS "createdAt"
           FROM extractions
           WHERE material_id = $1
           ORDER BY version_no DESC, created_at DESC
           LIMIT 1`,
          [materialId],
        );
        const flags = await readQuestionFlags(
          tx,
          scope.studentId,
          row.questionIds ?? [],
        );
        const record = extraction.rows[0];
        return {
          material: materialOf(row, flags),
          extraction: record
            ? {
                id: record.id,
                versionNo: record.versionNo,
                model: record.model,
                promptVersion: record.promptVersion,
                createdAt: record.createdAt.toISOString(),
              }
            : null,
        };
      },
    );
  }

  async listMaterialQuestions(
    scope: AdminInsightScope,
    materialId: string,
    page: PageQuery,
  ): Promise<InsightPage<MaterialQuestionDTO>> {
    const range = resolveInsightRange({}, this.now());
    return this.read(async (tx) => {
      await this.requireMaterial(tx, scope, materialId);
      const total = await tx.query<{ n: number }>(
        `SELECT count(DISTINCT qv.question_id)::int AS n
         FROM extractions e
         JOIN question_sources src ON src.extraction_id = e.id
         JOIN question_versions qv ON qv.id = src.question_version_id
         WHERE e.material_id = $1`,
        [materialId],
      );
      const rows = await tx.query<MaterialQuestionRow>(
        `SELECT question_id AS "questionId",
           question_version_id AS "questionVersionId",
           stem, knowledge_point AS "knowledgePoint"
         FROM (
           SELECT DISTINCT ON (qv.question_id)
             qv.question_id, qv.id AS question_version_id,
             qv.stem, qv.knowledge_point
           FROM extractions e
           JOIN question_sources src ON src.extraction_id = e.id
           JOIN question_versions qv ON qv.id = src.question_version_id
           WHERE e.material_id = $1
           ORDER BY qv.question_id, qv.version_no DESC, qv.id
         ) latest
         ORDER BY stem, "questionId"
         LIMIT $2 OFFSET $3`,
        [materialId, page.limit, page.offset],
      );
      const flags = await readQuestionFlags(
        tx,
        scope.studentId,
        rows.rows.map((row) => row.questionId),
      );
      return {
        items: rows.rows.map((row) => ({
          questionId: row.questionId,
          questionVersionId: row.questionVersionId,
          stem: row.stem,
          knowledgePoint: row.knowledgePoint,
          answered: flags.answered.has(row.questionId),
          verified: flags.verified.has(row.questionId),
        })),
        total: total.rows[0]!.n,
        meta: await this.meta(tx, range),
      };
    });
  }

  private async requireTask(
    tx: PoolClient,
    scope: AdminInsightScope,
    taskId: string,
  ): Promise<void> {
    const row = await tx.query(
      `SELECT 1 FROM learning_tasks
       WHERE id = $1 AND student_id = $2 AND deleted_at IS NULL`,
      [taskId, scope.studentId],
    );
    if (!row.rowCount) throw notFound("任务不存在");
  }

  private async requireMistake(
    tx: PoolClient,
    scope: AdminInsightScope,
    mistakeId: string,
  ): Promise<void> {
    const row = await tx.query(
      "SELECT 1 FROM student_mistakes WHERE id = $1 AND student_id = $2",
      [mistakeId, scope.studentId],
    );
    if (!row.rowCount) throw notFound("错题不存在");
  }

  private async requireMaterial(
    tx: PoolClient,
    scope: AdminInsightScope,
    materialId: string,
  ): Promise<void> {
    const row = await tx.query(
      "SELECT 1 FROM materials WHERE id = $1 AND student_id = $2",
      [materialId, scope.studentId],
    );
    if (!row.rowCount) throw notFound("资料不存在");
  }
}

type QuestionFlags = {
  answered: Set<string>;
  verified: Set<string>;
};

async function readQuestionFlags(
  tx: PoolClient,
  studentId: string,
  questionIds: string[],
): Promise<QuestionFlags> {
  const answered = new Set<string>();
  const verified = new Set<string>();
  if (questionIds.length === 0) return { answered, verified };
  const rows = await tx.query<{ questionId: string; verified: boolean | null }>(
    `SELECT DISTINCT v.question_id AS "questionId",
       (s.verification = 'verified'
         AND s.correctness IN ('correct','incorrect')) AS verified
     FROM attempts a
     JOIN question_versions v ON v.id = a.question_version_id
     LEFT JOIN learning_tasks t ON t.id = a.task_id
     ${LATEST_ASSESSMENT}
     WHERE a.student_id = $1
       AND v.question_id = ANY($2::uuid[])
       AND (a.task_id IS NULL OR t.deleted_at IS NULL)
       AND ${VALID_ATTEMPT}`,
    [studentId, questionIds],
  );
  for (const row of rows.rows) {
    answered.add(row.questionId);
    if (row.verified === true) verified.add(row.questionId);
  }
  return { answered, verified };
}

function materialOf(row: MaterialRow, flags: QuestionFlags): MaterialRecordDTO {
  const questions = row.questionIds ?? [];
  return {
    id: row.id,
    fileId: row.fileId,
    name: row.name,
    contentType: row.contentType,
    type: row.type,
    status: row.status,
    revisionId: row.revisionId,
    createdAt: row.createdAt.toISOString(),
    questions: questions.length,
    answered: questions.filter((id) => flags.answered.has(id)).length,
    verified: questions.filter((id) => flags.verified.has(id)).length,
  };
}
