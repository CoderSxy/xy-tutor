import { createHash } from "node:crypto";
import { z } from "zod";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { AuthService } from "../auth/service.js";
import type { UploadService } from "../uploads/service.js";
import type { CatalogService } from "../catalog/service.js";
import { JobQueue } from "../../jobs/queue.js";
import {
  extractionSchema,
  confirmationSchema,
  type ExtractionInput,
} from "./contracts.js";
export class MaterialService {
  constructor(
    readonly db: Database,
    readonly auth: AuthService,
    readonly uploads: UploadService,
    readonly catalog: CatalogService,
  ) {}
  async authorize(scope: StudentScope, id: string) {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    z.uuid().parse(id);
    const row = (
      await this.db.pool.query(
        "SELECT * FROM materials WHERE id=$1 AND student_id=$2",
        [id, scope.studentId],
      )
    ).rows[0];
    if (!row) throw new AppError("NOT_FOUND", 404, "资料不存在");
    return row;
  }
  async create(scope: StudentScope, input: unknown): Promise<{ id: string }> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const v = z
      .object({
        fileId: z.uuid(),
        type: z.enum(["mistake", "exam", "homework", "other"]),
        revisionId: z.uuid(),
      })
      .strict()
      .parse(input);
    const file = await this.uploads.authorize(scope.actor, v.fileId);
    if (
      file.student_id !== scope.studentId ||
      file.status !== "ready" ||
      file.purpose !== "student_material"
    )
      throw new AppError("NOT_FOUND", 404, "学生文件不存在或未就绪");
    await this.catalog.getRevision(scope.actor, v.revisionId);
    return inTransaction(this.db, async (tx) => {
      const r = (
        await tx.query(
          "INSERT INTO materials(student_id,file_id,revision_id,type) VALUES($1,$2,$3,$4) RETURNING id",
          [scope.studentId, v.fileId, v.revisionId, v.type],
        )
      ).rows[0];
      await new JobQueue(this.db).enqueue(tx, {
        kind: "material.parse",
        dedupeKey: `material:${r.id}`,
        payload: { materialId: r.id },
      });
      return { id: r.id };
    });
  }
  async list(scope: StudentScope) {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    return (
      await this.db.pool.query(
        'SELECT m.id,m.file_id AS "fileId",m.revision_id AS "revisionId",m.type,m.status,m.extraction_version AS "extractionVersion",f.name FROM materials m JOIN files f ON f.id=m.file_id WHERE m.student_id=$1 ORDER BY m.created_at DESC',
        [scope.studentId],
      )
    ).rows;
  }
  async saveExtraction(
    id: string,
    input: unknown,
    model = "manual-test-or-text-extraction",
    lease?: { jobId: string; token: string },
  ): Promise<void> {
    const v = extractionSchema.parse(input);
    await inTransaction(this.db, async (tx) => {
      if (
        lease &&
        !(
          await tx.query(
            "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND status='running' FOR UPDATE",
            [lease.jobId, lease.token],
          )
        ).rowCount
      )
        throw Error("STALE_JOB");
      const m = (
        await tx.query("SELECT * FROM materials WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!m) throw Error("MATERIAL_NOT_FOUND");
      if (m.status === "review" || m.status === "confirmed") return;
      for (const page of v.pages)
        await tx.query(
          "INSERT INTO material_pages(material_id,page_index,text,status) VALUES($1,$2,$3,$4) ON CONFLICT(material_id,page_index) DO UPDATE SET text=EXCLUDED.text,status=EXCLUDED.status",
          [id, page.pdfPageIndex, page.text, page.status],
        );
      const version = m.extraction_version + 1;
      await tx.query(
        "INSERT INTO extractions(material_id,version_no,payload,model,prompt_version) VALUES($1,$2,$3,$4,'extract-v1')",
        [id, version, JSON.stringify(v), model],
      );
      await tx.query(
        "UPDATE materials SET status='review',extraction_version=$1 WHERE id=$2",
        [version, id],
      );
    });
  }
  async getExtraction(
    scope: StudentScope,
    id: string,
  ): Promise<{
    version: number;
    extractionId?: string;
    payload?: ExtractionInput;
    status: string;
    fileId: string;
    revisionId: string;
    confirmedQuestionVersionIds: string[];
  }> {
    const m = await this.authorize(scope, id);
    const e = (
      await this.db.pool.query(
        "SELECT id,payload FROM extractions WHERE material_id=$1 AND version_no=$2",
        [id, m.extraction_version],
      )
    ).rows[0];
    const confirmed = e
      ? (
          await this.db.pool.query(
            "SELECT question_version_ids FROM material_confirmations WHERE extraction_id=$1",
            [e.id],
          )
        ).rows.flatMap((r) => r.question_version_ids as string[])
      : [];
    return {
      version: m.extraction_version,
      extractionId: e?.id,
      payload: e?.payload,
      status: m.status,
      fileId: m.file_id,
      revisionId: m.revision_id,
      confirmedQuestionVersionIds: confirmed,
    };
  }
  async confirm(
    scope: StudentScope,
    input: unknown,
  ): Promise<{ questionVersionIds: string[] }> {
    const v = confirmationSchema.parse(input);
    await this.authorize(scope, v.materialId);
    const hash = createHash("sha256")
      .update(JSON.stringify(v.questions))
      .digest("hex");
    return inTransaction(this.db, async (tx) => {
      const m = (
        await tx.query("SELECT * FROM materials WHERE id=$1 FOR UPDATE", [
          v.materialId,
        ])
      ).rows[0];
      if (m.extraction_version !== v.extractionVersion)
        throw new AppError("CONFLICT", 409, "识别结果已更新，请刷新");
      const e = (
        await tx.query(
          "SELECT * FROM extractions WHERE material_id=$1 AND version_no=$2",
          [m.id, v.extractionVersion],
        )
      ).rows[0];
      if (!e) throw new AppError("CONFLICT", 409, "资料尚未解析");
      const previous = (
        await tx.query(
          "SELECT * FROM material_confirmations WHERE extraction_id=$1",
          [e.id],
        )
      ).rows;
      const duplicate = previous.find((p) => p.request_hash === hash);
      if (duplicate)
        return {
          questionVersionIds: duplicate.question_version_ids as string[],
        };
      const payload = extractionSchema.parse(e.payload);
      const known = new Set(payload.questions.map((q) => q.candidateId));
      const used = new Set(
        previous.flatMap((p) => p.candidate_ids as string[]),
      );
      const selected = [...new Set(v.questions.flatMap((q) => q.candidateIds))];
      if (selected.some((id) => !known.has(id) || used.has(id)))
        throw new AppError("CONFLICT", 409, "题目已确认或不属于本次识别");
      const ids: string[] = [];
      for (const q of v.questions) {
        const question = (
          await tx.query(
            "INSERT INTO questions(student_id,revision_id,source_type) VALUES($1,$2,'material') RETURNING id",
            [scope.studentId, m.revision_id],
          )
        ).rows[0];
        const version = (
          await tx.query(
            "INSERT INTO question_versions(question_id,version_no,stem) VALUES($1,1,$2) RETURNING id",
            [question.id, q.stem],
          )
        ).rows[0];
        for (const source of q.sources) {
          const page = (
            await tx.query(
              "SELECT id FROM material_pages WHERE material_id=$1 AND page_index=$2",
              [m.id, source.pageIndex],
            )
          ).rows[0];
          if (!page) throw new AppError("VALIDATION", 422, "原图页码不正确");
          await tx.query(
            "INSERT INTO question_sources(question_version_id,extraction_id,page_id,bbox,teacher_annotation) VALUES($1,$2,$3,$4,$5)",
            [
              version.id,
              e.id,
              page.id,
              JSON.stringify(source.bbox),
              q.teacherAnnotation ?? null,
            ],
          );
        }
        if (q.studentAnswer?.trim()) {
          const a = (
            await tx.query(
              "INSERT INTO attempts(student_id,question_version_id,request_key,answer) VALUES($1,$2,$3,$4) RETURNING id",
              [
                scope.studentId,
                version.id,
                `import:${version.id}`,
                q.studentAnswer,
              ],
            )
          ).rows[0];
          await tx.query(
            "INSERT INTO attempt_evidence(attempt_id,extraction_id,source_type) VALUES($1,$2,'confirmed_import')",
            [a.id, e.id],
          );
        }
        ids.push(version.id);
      }
      await tx.query(
        "INSERT INTO material_confirmations(extraction_id,request_hash,candidate_ids,question_version_ids) VALUES($1,$2,$3,$4)",
        [e.id, hash, JSON.stringify(selected), JSON.stringify(ids)],
      );
      const allConfirmed = new Set([...used, ...selected]);
      await tx.query("UPDATE materials SET status=$1 WHERE id=$2", [
        allConfirmed.size === known.size ? "confirmed" : "review",
        m.id,
      ]);
      return { questionVersionIds: ids };
    });
  }
  async attachToTask(
    scope: StudentScope,
    taskId: string,
    versionIds: string[],
  ): Promise<void> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    z.array(z.uuid()).min(1).max(100).parse(versionIds);
    await inTransaction(this.db, async (tx) => {
      const task = (
        await tx.query(
          "SELECT * FROM learning_tasks WHERE id=$1 AND student_id=$2 FOR UPDATE",
          [taskId, scope.studentId],
        )
      ).rows[0];
      if (!task) throw new AppError("NOT_FOUND", 404, "学习任务不存在");
      if (task.status !== "active")
        throw new AppError("CONFLICT", 409, "任务未进行");
      for (const id of new Set(versionIds)) {
        const q = (
          await tx.query(
            "SELECT 1 FROM question_versions v JOIN questions q ON q.id=v.question_id WHERE v.id=$1 AND q.student_id=$2 AND q.revision_id=$3",
            [id, scope.studentId, task.revision_id],
          )
        ).rowCount;
        if (!q)
          throw new AppError("NOT_FOUND", 404, "题目不属于当前学生和教材");
        await tx.query(
          "INSERT INTO task_items(task_id,question_version_id,position,role) SELECT $1,$2,COALESCE(MAX(position),-1)+1,'original' FROM task_items WHERE task_id=$1 ON CONFLICT(task_id,question_version_id) DO NOTHING",
          [taskId, id],
        );
      }
    });
  }
  async correctQuestion(
    scope: StudentScope,
    input: unknown,
  ): Promise<{ questionVersionId: string }> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const v = z
      .object({
        questionId: z.uuid(),
        expectedVersion: z.number().int().positive(),
        stem: z.string().trim().min(1).max(20000),
      })
      .strict()
      .parse(input);
    return inTransaction(this.db, async (tx) => {
      const q = (
        await tx.query(
          "SELECT * FROM questions WHERE id=$1 AND student_id=$2 FOR UPDATE",
          [v.questionId, scope.studentId],
        )
      ).rows[0];
      if (!q) throw new AppError("NOT_FOUND", 404, "题目不存在");
      const old = (
        await tx.query(
          "SELECT * FROM question_versions WHERE question_id=$1 ORDER BY version_no DESC LIMIT 1",
          [q.id],
        )
      ).rows[0];
      if (old.version_no !== v.expectedVersion)
        throw new AppError("CONFLICT", 409, "题目已更新");
      const next = (
        await tx.query(
          "INSERT INTO question_versions(question_id,version_no,stem) VALUES($1,$2,$3) RETURNING id",
          [q.id, old.version_no + 1, v.stem],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO question_sources(question_version_id,extraction_id,page_id,bbox,teacher_annotation) SELECT $1,extraction_id,page_id,bbox,teacher_annotation FROM question_sources WHERE question_version_id=$2",
        [next.id, old.id],
      );
      await tx.query(
        "INSERT INTO evidence_invalidations(student_id,evidence_version_id,reason) VALUES($1,$2,'question_corrected')",
        [scope.studentId, old.id],
      );
      return { questionVersionId: next.id };
    });
  }
  async sources(scope: StudentScope, versionId: string) {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    return (
      await this.db.pool.query(
        'SELECT s.bbox,p.page_index AS "pageIndex",m.file_id AS "fileId",s.teacher_annotation AS "teacherAnnotation" FROM question_sources s JOIN material_pages p ON p.id=s.page_id JOIN materials m ON m.id=p.material_id WHERE s.question_version_id=$1 AND m.student_id=$2',
        [versionId, scope.studentId],
      )
    ).rows;
  }
  async retry(scope: StudentScope, id: string): Promise<void> {
    await this.authorize(scope, id);
    await inTransaction(this.db, async (tx) => {
      const changed = await tx.query(
        "UPDATE materials SET status='processing' WHERE id=$1 AND status='failed' RETURNING id",
        [id],
      );
      if (!changed.rowCount)
        throw new AppError("CONFLICT", 409, "资料未处于失败状态");
      await tx.query(
        "UPDATE jobs SET status='queued',attempts=0,available_at=now() WHERE dedupe_key=$1 AND status='failed'",
        [`material:${id}`],
      );
    });
  }
  async getQuestion(scope: StudentScope, versionId: string) {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const row = (
      await this.db.pool.query(
        'SELECT v.id,v.question_id AS "questionId",v.version_no AS "versionNo",v.stem,v.knowledge_point AS "knowledgePoint",q.revision_id AS "revisionId" FROM question_versions v JOIN questions q ON q.id=v.question_id WHERE v.id=$1 AND q.student_id=$2',
        [versionId, scope.studentId],
      )
    ).rows[0];
    if (!row) throw new AppError("NOT_FOUND", 404, "题目不存在");
    return row;
  }
}
