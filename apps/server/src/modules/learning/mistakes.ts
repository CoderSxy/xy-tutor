import { z } from "zod";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type {
  MistakeDTO,
  MistakeOriginCategory,
  MistakeOriginDetail,
  MistakePage,
} from "../../../../../packages/contracts/src/mistakes.js";
import type { AuthService } from "../auth/service.js";
import {
  decideTransition,
  type MistakeState,
  type TransitionInput,
} from "./state-rules.js";

export type { MistakeDTO };

type AttemptOriginRow = {
  id: string;
  task_id: string | null;
  task_kind: string | null;
  task_student_id: string | null;
  message_version_id: string | null;
  conversation_id: string | null;
};

type QuestionRow = {
  version_id: string;
  question_id: string;
  owner_id: string | null;
  source_type: string;
};

const TASK_DETAIL: Record<string, MistakeOriginDetail> = {
  daily_practice: "daily_practice",
  knowledge_consolidation: "knowledge_consolidation",
  free_question: "free_question",
  mistake_review: "mistake_review",
  material_tutoring: "material_import",
};

const UPLOAD_SOURCES = new Set([
  "material",
  "material_import",
  "private_upload",
  "shared_upload",
]);

const MISTAKE_SELECT = `SELECT m.id,
  m.question_id AS "questionId",
  v.id AS "questionVersionId",
  v.stem,
  m.status,
  m.due_at AS "dueAt",
  m.version,
  m.original_attempt_id AS "originalAttemptId",
  EXISTS(
    SELECT 1 FROM attempts a
    JOIN message_attachments ma ON ma.message_version_id=a.message_version_id
    JOIN question_versions av ON av.id=a.question_version_id
    WHERE a.student_id=m.student_id AND av.question_id=m.question_id
  ) AS "hasImageEvidence",
  m.origin_category AS "originCategory",
  m.origin_detail AS "originDetail",
  m.lifecycle,
  m.origin_task_id AS "originTaskId",
  m.origin_conversation_id AS "originConversationId",
  m.origin_message_version_id AS "originMessageVersionId",
  m.origin_question_version_id AS "originQuestionVersionId"
FROM student_mistakes m
JOIN LATERAL(
  SELECT id,stem FROM question_versions WHERE question_id=m.question_id ORDER BY version_no DESC LIMIT 1
) v ON true`;

function toDto(row: Record<string, unknown>): MistakeDTO {
  return {
    ...(row as Omit<MistakeDTO, "dueAt">),
    dueAt: row.dueAt ? (row.dueAt as Date).toISOString() : null,
  };
}

function originFromAttempt(
  q: QuestionRow,
  attempt: AttemptOriginRow | undefined,
): {
  originCategory: MistakeOriginCategory;
  originDetail: MistakeOriginDetail;
  originTaskId: string | null;
  originConversationId: string | null;
  originMessageVersionId: string | null;
  originQuestionVersionId: string;
  provenance: Record<string, unknown>;
} {
  if (attempt?.task_id) {
    return {
      originCategory: "learning",
      originDetail: TASK_DETAIL[attempt.task_kind ?? ""] ?? "unknown",
      originTaskId: attempt.task_id,
      originConversationId: attempt.conversation_id,
      originMessageVersionId: attempt.message_version_id,
      originQuestionVersionId: q.version_id,
      provenance: {
        attemptId: attempt.id,
        taskId: attempt.task_id,
        questionVersionId: q.version_id,
        derivedBy: "server",
      },
    };
  }
  if (UPLOAD_SOURCES.has(q.source_type)) {
    return {
      originCategory: "uploaded",
      originDetail: "material_import",
      originTaskId: null,
      originConversationId: null,
      originMessageVersionId: null,
      originQuestionVersionId: q.version_id,
      provenance: {
        questionVersionId: q.version_id,
        sourceType: q.source_type,
        derivedBy: "server",
      },
    };
  }
  return {
    originCategory: "unknown",
    originDetail: "unknown",
    originTaskId: null,
    originConversationId: null,
    originMessageVersionId: null,
    originQuestionVersionId: q.version_id,
    provenance: { questionVersionId: q.version_id, derivedBy: "server" },
  };
}

export type MistakeListFilter = {
  includeArchived?: boolean;
  questionId?: string;
  origin?: MistakeOriginCategory;
  status?: MistakeState;
};

export class MistakeService {
  constructor(
    readonly db: Database,
    readonly auth: AuthService,
  ) {}

  private async loadAttempt(
    tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    scope: StudentScope,
    versionId: string,
    attemptId: string | undefined,
  ): Promise<AttemptOriginRow | undefined> {
    if (!attemptId) return undefined;
    const row = (
      await tx.query(
        `SELECT a.id,a.task_id,a.message_version_id,t.kind AS task_kind,t.student_id AS task_student_id,
           (SELECT c.id FROM conversations c WHERE c.task_id=a.task_id ORDER BY c.created_at DESC,c.id DESC LIMIT 1) AS conversation_id
         FROM attempts a
         LEFT JOIN learning_tasks t ON t.id=a.task_id
         WHERE a.id=$1 AND a.student_id=$2 AND a.question_version_id=$3`,
        [attemptId, scope.studentId, versionId],
      )
    ).rows[0] as AttemptOriginRow | undefined;
    if (!row) throw new AppError("NOT_FOUND", 404, "原始作答不存在");
    return row;
  }

  private async authorizeQuestion(
    tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    scope: StudentScope,
    q: QuestionRow | undefined,
    attempt: AttemptOriginRow | undefined,
  ) {
    if (!q) throw new AppError("NOT_FOUND", 404, "题目不存在");
    if (q.owner_id === scope.studentId) return;
    if (q.owner_id !== null)
      throw new AppError("NOT_FOUND", 404, "题目不存在");
    // Shared question: require a legal task item and the student's own attempt.
    if (!attempt || !attempt.task_id || attempt.task_student_id !== scope.studentId)
      throw new AppError("NOT_FOUND", 404, "题目不存在");
    const item = await tx.query(
      "SELECT 1 FROM task_items WHERE task_id=$1 AND question_version_id=$2",
      [attempt.task_id, q.version_id],
    );
    if (!item.rows.length) throw new AppError("NOT_FOUND", 404, "题目不存在");
    const entry = (
      await tx.query(
        "SELECT visibility,owner_id,status FROM question_bank_entries WHERE question_version_id=$1",
        [q.version_id],
      )
    ).rows[0] as
      | { visibility: string; owner_id: string | null; status: string }
      | undefined;
    if (
      !entry ||
      entry.status !== "published" ||
      !(entry.visibility === "shared" || entry.owner_id === scope.studentId)
    )
      throw new AppError("NOT_FOUND", 404, "题目不存在");
  }

  async add(scope: StudentScope, input: unknown): Promise<MistakeDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const v = z
      .object({ questionVersionId: z.uuid(), attemptId: z.uuid().optional() })
      .strict()
      .parse(input);
    const id = await inTransaction(this.db, async (tx) => {
      const q = (
        await tx.query(
          "SELECT v.id AS version_id,v.question_id,q.student_id AS owner_id,q.source_type FROM question_versions v JOIN questions q ON q.id=v.question_id WHERE v.id=$1",
          [v.questionVersionId],
        )
      ).rows[0] as QuestionRow | undefined;
      const attempt = await this.loadAttempt(
        tx,
        scope,
        v.questionVersionId,
        v.attemptId,
      );
      await this.authorizeQuestion(tx, scope, q, attempt);
      const origin = originFromAttempt(q!, attempt);
      const r = (
        await tx.query(
          `INSERT INTO student_mistakes(
             student_id,question_id,original_attempt_id,origin_category,origin_detail,
             origin_task_id,origin_conversation_id,origin_message_version_id,
             origin_question_version_id,provenance
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT(student_id,question_id) DO UPDATE SET
             original_attempt_id=COALESCE(student_mistakes.original_attempt_id,EXCLUDED.original_attempt_id)
           RETURNING id`,
          [
            scope.studentId,
            q!.question_id,
            v.attemptId ?? null,
            origin.originCategory,
            origin.originDetail,
            origin.originTaskId,
            origin.originConversationId,
            origin.originMessageVersionId,
            origin.originQuestionVersionId,
            JSON.stringify(origin.provenance),
          ],
        )
      ).rows[0];
      return r.id as string;
    });
    return this.get(scope, id);
  }

  async rebuild(scope: StudentScope): Promise<void> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    await inTransaction(this.db, async (tx) => {
      const invalid = new Set(
        (
          await tx.query(
            "SELECT evidence_version_id FROM evidence_invalidations WHERE student_id=$1",
            [scope.studentId],
          )
        ).rows.map((r) => r.evidence_version_id as string),
      );
      const latest = new Set(
        (
          await tx.query(
            "SELECT DISTINCT ON(s.attempt_id) s.id FROM assessments s JOIN attempts a ON a.id=s.attempt_id WHERE a.student_id=$1 AND s.verification='verified' ORDER BY s.attempt_id,s.created_at DESC,s.id DESC",
            [scope.studentId],
          )
        ).rows.map((r) => r.id as string),
      );
      const mistakes = (
        await tx.query(
          "SELECT * FROM student_mistakes WHERE student_id=$1 FOR UPDATE",
          [scope.studentId],
        )
      ).rows;
      for (const m of mistakes) {
        let state: MistakeState = "pending_correction";
        let consolidatedAt: Date | null = null,
          lastQuestion: string | null = null,
          dueAt: Date | null = null;
        const events = (
          await tx.query(
            "SELECT * FROM mistake_state_events WHERE mistake_id=$1 ORDER BY evidence_at,sequence",
            [m.id],
          )
        ).rows;
        let everIncorrect = false;
        let validIncorrect = false;
        for (const e of events) {
          const evidence = e.evidence as
            | {
                input?: TransitionInput;
                sourceVersionIds?: string[];
              }
            | undefined;
          const assessmentEvidence = !!e.assessment_id && !!evidence?.input;
          const sourceInvalid =
            !!evidence?.sourceVersionIds?.some((id) => invalid.has(id));
          if (assessmentEvidence) {
            if (
              evidence!.input!.verification === "verified" &&
              evidence!.input!.correctness === "incorrect"
            )
              everIncorrect = true;
            if (
              latest.has(e.assessment_id) &&
              !sourceInvalid &&
              evidence!.input!.verification === "verified" &&
              evidence!.input!.correctness === "incorrect"
            )
              validIncorrect = true;
          }
          if (e.type === "start" && state === "pending_correction") {
            state = "correcting";
            continue;
          }
          if (!e.assessment_id || !latest.has(e.assessment_id)) continue;
          if (!evidence?.input || sourceInvalid) continue;
          const input = {
            ...evidence.input,
            state,
            consolidatedAt,
            lastConsolidatedQuestionId: lastQuestion,
          };
          const decision = decideTransition(input, e.evidence_at);
          if (decision.changed) {
            state = decision.to;
            if (decision.consolidatedAt !== undefined)
              consolidatedAt = decision.consolidatedAt;
            if (decision.lastConsolidatedQuestionId !== undefined)
              lastQuestion = decision.lastConsolidatedQuestionId;
            if (decision.dueAt !== undefined) dueAt = decision.dueAt;
          }
        }
        const lifecycle: "active" | "revoked" = everIncorrect
          ? validIncorrect
            ? "active"
            : "revoked"
          : m.lifecycle === "revoked"
            ? "revoked"
            : "active";
        if (
          m.status !== state ||
          String(m.due_at) !== String(dueAt) ||
          String(m.consolidated_at) !== String(consolidatedAt) ||
          m.lifecycle !== lifecycle
        ) {
          await tx.query(
            "UPDATE student_mistakes SET status=$1,due_at=$2,consolidated_at=$3,last_consolidated_question_id=$4,lifecycle=$5,version=version+1 WHERE id=$6",
            [state, dueAt, consolidatedAt, lastQuestion, lifecycle, m.id],
          );
          await tx.query(
            "INSERT INTO mistake_state_events(mistake_id,type,from_state,to_state,reason,rule_version) VALUES($1,'projection',$2,$3,'根据有效证据重算当前状态','mistake-v1')",
            [m.id, m.status, state],
          );
        }
      }
    });
  }

  async applyAssessment(
    scope: StudentScope,
    assessmentId: string,
  ): Promise<MistakeDTO | undefined> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    z.uuid().parse(assessmentId);
    await this.rebuild(scope);
    const a = (
      await this.db.pool.query(
        "SELECT s.*,a.student_id,a.question_version_id,a.message_version_id,a.created_at AS attempt_at,q.id AS question_id,rel.origin_question_id,rel.origin_question_version_id,rel.verified AS relation_verified FROM assessments s JOIN attempts a ON a.id=s.attempt_id JOIN question_versions v ON v.id=a.question_version_id JOIN questions q ON q.id=v.question_id LEFT JOIN question_relations rel ON rel.variant_question_id=q.id WHERE s.id=$1 AND a.student_id=$2",
        [assessmentId, scope.studentId],
      )
    ).rows[0];
    if (!a) throw new AppError("NOT_FOUND", 404, "评估不存在");
    if (a.verification !== "verified" || a.correctness === "uncertain") return;
    const originalId = a.origin_question_id ?? a.question_id;
    let m = (
      await this.db.pool.query(
        "SELECT * FROM student_mistakes WHERE student_id=$1 AND question_id=$2",
        [scope.studentId, originalId],
      )
    ).rows[0];
    if (!m && a.correctness === "incorrect" && !a.origin_question_id) {
      await this.add(scope, {
        questionVersionId: a.question_version_id,
        attemptId: a.attempt_id,
      });
      m = (
        await this.db.pool.query(
          "SELECT * FROM student_mistakes WHERE student_id=$1 AND question_id=$2",
          [scope.studentId, originalId],
        )
      ).rows[0];
    }
    if (!m) return;
    const sourceVersionIds = [
      a.question_version_id,
      a.message_version_id,
      a.origin_question_version_id,
    ].filter(Boolean) as string[];
    if (
      (
        await this.db.pool.query(
          "SELECT 1 FROM evidence_invalidations WHERE student_id=$1 AND evidence_version_id=ANY($2::uuid[])",
          [scope.studentId, sourceVersionIds],
        )
      ).rowCount
    )
      return;
    await inTransaction(this.db, async (tx) => {
      const locked = (
        await tx.query(
          "SELECT * FROM student_mistakes WHERE id=$1 FOR UPDATE",
          [m.id],
        )
      ).rows[0];
      const input: TransitionInput = {
        state: locked.status,
        correctness: a.correctness,
        verification: a.verification,
        hintDependency: a.hint_dependency,
        practiceRole: a.origin_question_id ? "variant" : "original",
        variantVerified: !!a.relation_verified,
        consolidatedAt: locked.consolidated_at,
        lastConsolidatedQuestionId: locked.last_consolidated_question_id,
        questionId: a.question_id,
      };
      const decision = decideTransition(input, a.attempt_at);
      await tx.query(
        "INSERT INTO mistake_state_events(mistake_id,assessment_id,attempt_id,type,from_state,to_state,reason,rule_version,evidence,evidence_at) VALUES($1,$2,$3,'assessment',$4,$5,$6,$7,$8,$9) ON CONFLICT(mistake_id,assessment_id) DO NOTHING",
        [
          m.id,
          a.id,
          a.attempt_id,
          locked.status,
          decision.to,
          decision.reason,
          decision.ruleVersion,
          JSON.stringify({ input, sourceVersionIds }),
          a.attempt_at,
        ],
      );
    });
    return this.get(scope, m.id);
  }

  async start(scope: StudentScope, id: string): Promise<MistakeDTO> {
    await this.get(scope, id);
    await inTransaction(this.db, async (tx) => {
      const m = (
        await tx.query(
          "SELECT status FROM student_mistakes WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (m.status === "pending_correction")
        await tx.query(
          "INSERT INTO mistake_state_events(mistake_id,type,from_state,to_state,reason,rule_version) VALUES($1,'start','pending_correction','correcting','已开始订正辅导','mistake-v1')",
          [id],
        );
    });
    return this.get(scope, id);
  }

  async get(scope: StudentScope, id: string): Promise<MistakeDTO> {
    await this.rebuild(scope);
    z.uuid().parse(id);
    const r = (
      await this.db.pool.query(
        `${MISTAKE_SELECT} WHERE m.id=$1 AND m.student_id=$2`,
        [id, scope.studentId],
      )
    ).rows[0];
    if (!r) throw new AppError("NOT_FOUND", 404, "错题不存在");
    return toDto(r);
  }

  async list(
    scope: StudentScope,
    filter: MistakeListFilter = {},
  ): Promise<MistakeDTO[]> {
    await this.rebuild(scope);
    const r = await this.db.pool.query(
      `${MISTAKE_SELECT}
       WHERE m.student_id=$1
         AND ($2::boolean OR (m.status<>'mastered' AND m.lifecycle='active'))
         AND ($3::text IS NULL OR m.origin_category=$3)
         AND ($4::text IS NULL OR m.status=$4)
         AND ($5::uuid IS NULL OR m.question_id=$5)
       ORDER BY m.due_at NULLS LAST,m.created_at DESC,m.id
       LIMIT 100`,
      [
        scope.studentId,
        !!filter.includeArchived,
        filter.origin ?? null,
        filter.status ?? null,
        filter.questionId ?? null,
      ],
    );
    return r.rows.map(toDto);
  }

  async listPage(
    scope: StudentScope,
    filter: MistakeListFilter & { page?: number; pageSize?: number } = {},
  ): Promise<MistakePage> {
    await this.rebuild(scope);
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, filter.pageSize ?? 20));
    const base = `m.student_id=$1
      AND ($2::boolean OR (m.status<>'mastered' AND m.lifecycle='active'))
      AND ($3::text IS NULL OR m.status=$3)
      AND ($4::uuid IS NULL OR m.question_id=$4)`;
    const params = [
      scope.studentId,
      !!filter.includeArchived,
      filter.status ?? null,
      filter.questionId ?? null,
    ];
    const [counts, total, items] = await Promise.all([
      this.db.pool.query(
        `SELECT count(*)::int AS all,
           count(*) FILTER (WHERE m.origin_category='uploaded')::int AS uploaded,
           count(*) FILTER (WHERE m.origin_category='learning')::int AS learning,
           count(*) FILTER (WHERE m.origin_category='unknown')::int AS unknown
         FROM student_mistakes m WHERE ${base}`,
        params,
      ),
      this.db.pool.query(
        `SELECT count(*)::int AS total FROM student_mistakes m
         WHERE ${base} AND ($5::text IS NULL OR m.origin_category=$5)`,
        [...params, filter.origin ?? null],
      ),
      this.db.pool.query(
        `${MISTAKE_SELECT}
         WHERE ${base} AND ($5::text IS NULL OR m.origin_category=$5)
         ORDER BY m.due_at NULLS LAST,m.created_at DESC,m.id
         LIMIT $6 OFFSET $7`,
        [...params, filter.origin ?? null, pageSize, (page - 1) * pageSize],
      ),
    ]);
    return {
      items: items.rows.map(toDto),
      total: total.rows[0]?.total ?? 0,
      page,
      pageSize,
      originCounts: counts.rows[0] as MistakePage["originCounts"],
    };
  }

  async history(scope: StudentScope, id: string) {
    await this.get(scope, id);
    return (
      await this.db.pool.query(
        'SELECT id,assessment_id AS "assessmentId",attempt_id AS "attemptId",type,from_state AS "fromState",to_state AS "toState",reason,rule_version AS "ruleVersion",evidence_at AS "evidenceAt",created_at AS "createdAt" FROM mistake_state_events WHERE mistake_id=$1 ORDER BY sequence',
        [id],
      )
    ).rows;
  }
}
