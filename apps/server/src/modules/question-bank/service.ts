import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { Actor } from "../../../../../packages/contracts/src/domain.js";
import {
  adminQuestionInputSchema,
  questionEntryInputSchema,
  type QuestionBankEntrySummaryDTO,
  type QuestionEntryDTO,
  type QuestionEntryInput,
  type QuestionTemplateDTO,
} from "../../../../../packages/contracts/src/question-bank.js";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { PoolClient } from "pg";
import { requireAdmin } from "../auth/policy.js";

type VersionRow = {
  version_id: string;
  question_id: string;
  student_id: string | null;
  stem: string;
  reference_answer: string | null;
  knowledge_point: string | null;
  rubric: unknown;
  verification: string;
};

type EntryRow = {
  id: string;
  question_version_id: string;
  difficulty_band: string;
  complexity_band: number;
  visibility: string;
  owner_id: string | null;
  status: string;
  version: number;
  published_at: Date | null;
  skill_id: string;
};

const ENTRY_COLUMNS =
  "e.id,e.question_version_id,e.difficulty_band,e.complexity_band,e.visibility,e.owner_id,e.status,e.version,e.published_at,l.skill_id";

function fingerprint(stem: string, referenceAnswer: string | null): string {
  return createHash("sha256")
    .update(`${stem}\u0000${referenceAnswer ?? ""}`)
    .digest("hex");
}

function entryDTO(row: EntryRow): QuestionEntryDTO {
  return {
    id: row.id,
    questionVersionId: row.question_version_id,
    skillId: row.skill_id,
    difficultyBand: row.difficulty_band as QuestionEntryDTO["difficultyBand"],
    complexityBand: row.complexity_band,
    visibility: row.visibility as QuestionEntryDTO["visibility"],
    ownerId: row.owner_id,
    status: row.status as QuestionEntryDTO["status"],
    version: row.version,
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
  };
}

async function loadEntry(
  tx: PoolClient,
  entryId: string,
  forUpdate = false,
): Promise<EntryRow | undefined> {
  return (
    await tx.query<EntryRow>(
      `SELECT ${ENTRY_COLUMNS}
         FROM question_bank_entries e
         JOIN question_skill_links l ON l.entry_id = e.id AND l.is_primary
        WHERE e.id = $1${forUpdate ? " FOR UPDATE OF e" : ""}`,
      [entryId],
    )
  ).rows[0];
}

export class QuestionBankService {
  constructor(private db: Database) {}

  async createDraft(
    actor: Actor,
    input: QuestionEntryInput,
  ): Promise<QuestionEntryDTO> {
    const parsed = questionEntryInputSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError("VALIDATION", 422, "题库参数不正确");
    const data = parsed.data;
    if (data.visibility === "shared" && actor.role !== "admin")
      throw new AppError("FORBIDDEN", 403, "共享题目需要管理员审核发布");

    return inTransaction(this.db, async (tx) => {
      const version = (
        await tx.query<VersionRow>(
          `SELECT qv.id AS version_id, qv.question_id, q.student_id, qv.stem,
                  qv.reference_answer, qv.knowledge_point, qv.rubric, qv.verification
             FROM question_versions qv
             JOIN questions q ON q.id = qv.question_id
            WHERE qv.id = $1`,
          [data.questionVersionId],
        )
      ).rows[0];
      if (!version) throw new AppError("NOT_FOUND", 404, "题目不存在");

      const ownerId = version.student_id;
      if (data.visibility === "owner_only") {
        if (!ownerId)
          throw new AppError("VALIDATION", 422, "私人题必须属于某个学生");
        if (actor.role !== "admin") {
          const studentId = await this.ownerStudentId(tx, actor);
          if (studentId !== ownerId)
            throw new AppError("NOT_FOUND", 404, "题目不存在");
        }
      }

      if (data.knowledgeItemId) {
        const item = (
          await tx.query<{ status: string }>(
            "SELECT status FROM knowledge_items WHERE id=$1",
            [data.knowledgeItemId],
          )
        ).rows[0];
        if (!item) throw new AppError("NOT_FOUND", 404, "知识点不存在");
        if (item.status !== "published")
          throw new AppError("CONFLICT", 409, "只有已发布的知识点可以作为题目依据");
        const link = (
          await tx.query(
            "SELECT 1 FROM skill_content_links WHERE skill_id=$1 AND knowledge_item_id=$2",
            [data.skillId, data.knowledgeItemId],
          )
        ).rowCount;
        if (!link)
          throw new AppError("CONFLICT", 409, "知识点尚未关联到该技能");
      }

      const content = fingerprint(version.stem, version.reference_answer);
      const existing = (
        await tx.query<EntryRow>(
          `SELECT ${ENTRY_COLUMNS}
             FROM question_bank_entries e
             JOIN question_skill_links l ON l.entry_id = e.id AND l.is_primary
            WHERE e.visibility = $1
              AND e.content_fingerprint = $2
              AND ($1 = 'shared' OR e.owner_id = $3::uuid)`,
          [data.visibility, content, ownerId],
        )
      ).rows[0];
      if (existing) return entryDTO(existing);

      let questionVersionId = version.version_id;
      if (data.visibility === "shared" && version.student_id) {
        questionVersionId = await this.copyDesensitized(tx, version);
      }

      const skill = (
        await tx.query<{ id: string }>(
          "SELECT id FROM skills WHERE id=$1 AND status='active'",
          [data.skillId],
        )
      ).rows[0];
      if (!skill) throw new AppError("NOT_FOUND", 404, "技能不存在");

      const entryId = (
        await tx.query<{ id: string }>(
          `INSERT INTO question_bank_entries(
             question_version_id,difficulty_band,complexity_band,visibility,owner_id,
             source_type,source_ref,template_family,content_fingerprint,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id`,
          [
            questionVersionId,
            data.difficultyBand,
            data.complexityBand,
            data.visibility,
            ownerId,
            data.sourceType,
            data.sourceRef ?? null,
            data.templateFamily ?? null,
            content,
            actor.userId,
          ],
        )
      ).rows[0]!.id;
      await tx.query(
        "INSERT INTO question_skill_links(entry_id,skill_id,is_primary) VALUES($1,$2,true)",
        [entryId, data.skillId],
      );
      await tx.query(
        "INSERT INTO audit_events(actor_id,action,details) VALUES($1,'question_bank.entry.create',$2)",
        [actor.userId, JSON.stringify({ entryId, skillId: data.skillId })],
      );
      const created = await loadEntry(tx, entryId);
      return entryDTO(created!);
    });
  }

  async publish(
    actor: Actor,
    entryId: string,
    expectedVersion: number,
  ): Promise<QuestionEntryDTO> {
    requireAdmin(actor);
    z.uuid().parse(entryId);
    return inTransaction(this.db, async (tx) => {
      const entry = await loadEntry(tx, entryId, true);
      if (!entry) throw new AppError("NOT_FOUND", 404, "题目条目不存在");
      if (entry.version !== expectedVersion)
        throw new AppError("CONFLICT", 409, "条目已被修改，请重新审核");
      if (entry.status !== "pending_review")
        throw new AppError("CONFLICT", 409, "只有待审核的条目可以发布");
      await tx.query(
        "UPDATE question_bank_entries SET status='published',published_at=now(),version=version+1,updated_at=now() WHERE id=$1",
        [entryId],
      );
      await tx.query(
        "INSERT INTO audit_events(actor_id,action,details) VALUES($1,'question_bank.entry.publish',$2)",
        [actor.userId, JSON.stringify({ entryId })],
      );
      return entryDTO((await loadEntry(tx, entryId))!);
    });
  }

  async withdraw(
    actor: Actor,
    entryId: string,
    reason: string,
  ): Promise<QuestionEntryDTO> {
    z.uuid().parse(entryId);
    const trimmed = reason.trim();
    if (!trimmed) throw new AppError("VALIDATION", 422, "撤回原因不能为空");
    return inTransaction(this.db, async (tx) => {
      const entry = await loadEntry(tx, entryId, true);
      if (!entry) throw new AppError("NOT_FOUND", 404, "题目条目不存在");
      if (actor.role !== "admin") {
        const studentId = await this.ownerStudentId(tx, actor);
        if (!studentId || entry.owner_id !== studentId)
          throw new AppError("NOT_FOUND", 404, "题目条目不存在");
      }
      if (entry.status === "withdrawn")
        throw new AppError("CONFLICT", 409, "条目已经撤回");
      await tx.query(
        "UPDATE question_bank_entries SET status='withdrawn',published_at=NULL,withdrawn_reason=$2,version=version+1,updated_at=now() WHERE id=$1",
        [entryId, trimmed],
      );
      await tx.query(
        "INSERT INTO audit_events(actor_id,action,details) VALUES($1,'question_bank.entry.withdraw',$2)",
        [actor.userId, JSON.stringify({ entryId, reason: trimmed })],
      );
      return entryDTO((await loadEntry(tx, entryId))!);
    });
  }

  async createAdminEntry(
    actor: Actor,
    input: unknown,
  ): Promise<QuestionBankEntrySummaryDTO> {
    requireAdmin(actor);
    const data = adminQuestionInputSchema.parse(input);
    const entryId = await inTransaction(this.db, async (tx) => {
      const skill = (
        await tx.query<{ id: string }>(
          "SELECT id FROM skills WHERE id=$1 AND status='active'",
          [data.skillId],
        )
      ).rows[0];
      if (!skill) throw new AppError("NOT_FOUND", 404, "技能不存在");
      if (data.knowledgeItemId) {
        const item = (
          await tx.query<{ status: string }>(
            "SELECT status FROM knowledge_items WHERE id=$1",
            [data.knowledgeItemId],
          )
        ).rows[0];
        if (!item) throw new AppError("NOT_FOUND", 404, "知识点不存在");
        if (item.status !== "published")
          throw new AppError("CONFLICT", 409, "只有已发布的知识点可以作为题目依据");
        const link = (
          await tx.query(
            "SELECT 1 FROM skill_content_links WHERE skill_id=$1 AND knowledge_item_id=$2",
            [data.skillId, data.knowledgeItemId],
          )
        ).rowCount;
        if (!link)
          throw new AppError("CONFLICT", 409, "知识点尚未关联到该技能");
      }
      const content = fingerprint(data.stem, data.referenceAnswer);
      const existing = (
        await tx.query<{ id: string }>(
          `SELECT id FROM question_bank_entries
            WHERE visibility='shared' AND content_fingerprint=$1 LIMIT 1`,
          [content],
        )
      ).rows[0];
      if (existing)
        throw new AppError("CONFLICT", 409, "同名题目已在题库中");

      const questionId = (
        await tx.query<{ id: string }>(
          "INSERT INTO questions(student_id,source_type) VALUES(NULL,'bank') RETURNING id",
        )
      ).rows[0]!.id;
      const versionId = (
        await tx.query<{ id: string }>(
          `INSERT INTO question_versions(question_id,version_no,stem,reference_answer,verification)
           VALUES($1,1,$2,$3,'pending') RETURNING id`,
          [questionId, data.stem, data.referenceAnswer],
        )
      ).rows[0]!.id;
      await tx.query(
        `INSERT INTO question_references(
           question_version_id,answer,answer_type,requires_working,verification,evidence)
         VALUES($1,$2,'text',false,'pending',$3)`,
        [
          versionId,
          data.referenceAnswer,
          JSON.stringify({
            source: data.sourceType,
            sourceRef: data.sourceRef ?? null,
            knowledgeItemId: data.knowledgeItemId ?? null,
          }),
        ],
      );
      const entryId = (
        await tx.query<{ id: string }>(
          `INSERT INTO question_bank_entries(
             question_version_id,difficulty_band,complexity_band,visibility,owner_id,
             source_type,source_ref,template_family,content_fingerprint,status,
             published_at,created_by)
           VALUES($1,$2,$3,'shared',NULL,$4,$5,$6,$7,'pending_review',NULL,$8)
           RETURNING id`,
          [
            versionId,
            data.difficultyBand,
            data.complexityBand,
            data.sourceType,
            data.sourceRef ?? null,
            data.templateFamily ?? null,
            content,
            actor.userId,
          ],
        )
      ).rows[0]!.id;
      await tx.query(
        "INSERT INTO question_skill_links(entry_id,skill_id,is_primary) VALUES($1,$2,true)",
        [entryId, data.skillId],
      );
      await tx.query(
        "INSERT INTO audit_events(actor_id,action,details) VALUES($1,'question_bank.entry.create',$2)",
        [actor.userId, JSON.stringify({ entryId, skillId: data.skillId })],
      );
      return entryId;
    });
    const created = (
      await this.listEntries(actor, "pending_review", 100)
    ).items.find((item) => item.id === entryId);
    if (!created) throw new AppError("NOT_FOUND", 404, "题目条目不存在");
    return created;
  }

  async listEntries(
    actor: Actor,
    status: string | undefined,
    limit: number,
  ): Promise<{ items: QuestionBankEntrySummaryDTO[]; total: number }> {
    requireAdmin(actor);
    const rows = (
      await this.db.pool.query(
        `SELECT e.id,e.question_version_id,e.difficulty_band,e.complexity_band,
                e.visibility,e.owner_id,e.status,e.version,e.source_type,
                e.source_ref,e.template_family,e.published_at,
                l.skill_id,s.name AS skill_name,qv.stem,qv.verification
           FROM question_bank_entries e
           JOIN question_skill_links l ON l.entry_id=e.id AND l.is_primary
           JOIN skills s ON s.id=l.skill_id
           JOIN question_versions qv ON qv.id=e.question_version_id
          WHERE ($1::text IS NULL OR e.status=$1)
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT $2`,
        [status ?? null, limit],
      )
    ).rows;
    const total = (
      await this.db.pool.query(
        `SELECT count(*)::int AS total FROM question_bank_entries e
          WHERE ($1::text IS NULL OR e.status=$1)`,
        [status ?? null],
      )
    ).rows[0]!.total as number;
    return {
      items: rows.map((row) => ({
        id: row.id,
        questionVersionId: row.question_version_id,
        skillId: row.skill_id,
        skillName: row.skill_name,
        stem: row.stem,
        difficultyBand: row.difficulty_band,
        complexityBand: Number(row.complexity_band),
        visibility: row.visibility,
        ownerId: row.owner_id,
        status: row.status,
        version: Number(row.version),
        sourceType: row.source_type,
        sourceRef: row.source_ref,
        templateFamily: row.template_family,
        verification: row.verification,
        publishedAt: row.published_at ? row.published_at.toISOString() : null,
      })),
      total,
    };
  }

  async listTemplates(
    actor: Actor,
  ): Promise<{ items: QuestionTemplateDTO[] }> {
    requireAdmin(actor);
    const rows = (
      await this.db.pool.query(
        `SELECT id,family,skill_id,difficulty_band,version,status,approved_at
           FROM question_templates
          ORDER BY created_at DESC, id DESC`,
      )
    ).rows;
    return {
      items: rows.map((row) => ({
        id: row.id,
        family: row.family,
        skillId: row.skill_id,
        difficultyBand: row.difficulty_band,
        version: Number(row.version),
        status: row.status,
        approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
      })),
    };
  }

  async reviewTemplate(
    actor: Actor,
    templateId: string,
    decision: "approved" | "rejected",
  ): Promise<QuestionTemplateDTO> {
    requireAdmin(actor);
    z.uuid().parse(templateId);
    return inTransaction(this.db, async (tx) => {
      const template = (
        await tx.query(
          `SELECT id,family,skill_id,difficulty_band,version,status,approved_at
             FROM question_templates WHERE id=$1 FOR UPDATE`,
          [templateId],
        )
      ).rows[0];
      if (!template) throw new AppError("NOT_FOUND", 404, "模板不存在");
      if (template.status !== "pending_review")
        throw new AppError("CONFLICT", 409, "模板已审核");
      const approved = decision === "approved";
      await tx.query(
        `UPDATE question_templates
            SET status=$2,approved_by=$3,approved_at=$4
          WHERE id=$1`,
        [templateId, decision, approved ? actor.userId : null, approved ? new Date() : null],
      );
      await tx.query(
        "INSERT INTO audit_events(actor_id,action,details) VALUES($1,'question_bank.template.review',$2)",
        [actor.userId, JSON.stringify({ templateId, decision })],
      );
      return {
        id: template.id,
        family: template.family,
        skillId: template.skill_id,
        difficultyBand: template.difficulty_band,
        version: Number(template.version),
        status: decision,
        approvedAt: approved ? new Date().toISOString() : null,
      };
    });
  }

  private async ownerStudentId(
    tx: PoolClient,
    actor: Actor,
  ): Promise<string | null> {
    return (
      await tx.query<{ student_id: string }>(
        "SELECT student_id FROM student_access WHERE user_id=$1 AND permission='owner' LIMIT 1",
        [actor.userId],
      )
    ).rows[0]?.student_id ?? null;
  }

  private async copyDesensitized(
    tx: PoolClient,
    version: VersionRow,
  ): Promise<string> {
    const questionId = (
      await tx.query<{ id: string }>(
        "INSERT INTO questions(student_id,source_type) VALUES(NULL,'shared_upload') RETURNING id",
      )
    ).rows[0]!.id;
    const versionId = (
      await tx.query<{ id: string }>(
        `INSERT INTO question_versions(question_id,version_no,stem,reference_answer,knowledge_point,rubric,verification)
         VALUES($1,1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          questionId,
          version.stem,
          version.reference_answer,
          version.knowledge_point,
          JSON.stringify(version.rubric ?? {}),
          version.verification,
        ],
      )
    ).rows[0]!.id;
    await tx.query(
      `INSERT INTO question_references(question_version_id,answer,answer_type,requires_working,verification,evidence)
       SELECT $1,answer,answer_type,requires_working,verification,evidence
         FROM question_references WHERE question_version_id=$2`,
      [versionId, version.version_id],
    );
    return versionId;
  }
}
