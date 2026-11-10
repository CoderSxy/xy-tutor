import { z } from "zod";
import { JobQueue } from "../../jobs/queue.js";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { AuthService } from "../auth/service.js";
import type { CatalogService } from "../catalog/service.js";
import {
  taskInput,
  questionInput,
  taskSelect,
  taskTitleInput,
  type TaskDTO,
  type TaskPage,
} from "./contracts.js";
export class TaskService {
  constructor(
    private db: Database,
    private auth: AuthService,
    private catalog: CatalogService,
  ) {}
  async create(scope: StudentScope, input: unknown): Promise<TaskDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const v = taskInput.parse(input);
    const id = await inTransaction(this.db, async (tx) => {
      if (v.creationKey) {
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",
          [scope.studentId, v.creationKey],
        );
        const existing = (
          await tx.query(
            "SELECT id,deleted_at,revision_id,kind,chapter_id FROM learning_tasks WHERE student_id=$1 AND creation_key=$2",
            [scope.studentId, v.creationKey],
          )
        ).rows[0];
        if (existing) {
          if (existing.deleted_at)
            throw new AppError("CONFLICT", 409, "任务已删除，请重新创建");
          if (existing.kind !== v.kind)
            throw new AppError("CONFLICT", 409, "创建参数与已有任务不同");
          return existing.id as string;
        }
      }
      const t = (
        await tx.query(
          "INSERT INTO learning_tasks(student_id,revision_id,kind,chapter_id,creation_key) VALUES($1,NULL,$2,NULL,$3) RETURNING id",
          [scope.studentId, v.kind, v.creationKey ?? null],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO conversations(student_id,task_id,revision_id) VALUES($1,$2,NULL)",
        [scope.studentId, t.id],
      );
      return t.id;
    });
    return this.resume(scope, id);
  }
  async resume(scope: StudentScope, id: string): Promise<TaskDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    z.uuid().parse(id);
    const task = (
      await this.db.pool.query<TaskDTO>(
        taskSelect +
          " WHERE t.id=$1 AND t.student_id=$2 AND t.deleted_at IS NULL",
        [id, scope.studentId],
      )
    ).rows[0];
    if (!task) throw new AppError("NOT_FOUND", 404, "任务不存在");
    return task;
  }
  async list(
    scope: StudentScope,
    opts: { revisionId?: string; q?: string; limit: number; offset: number },
  ): Promise<TaskPage> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const pattern = opts.q ? `%${opts.q.replace(/[\\%_]/g, "\\$&")}%` : null;
    const where = `WHERE t.student_id=$1 AND t.deleted_at IS NULL AND ($2::uuid IS NULL OR t.revision_id=$2) AND ($3::text IS NULL OR (t.title ILIKE $3 OR EXISTS (SELECT 1 FROM message_versions mv JOIN messages m ON m.id=mv.message_id JOIN conversations c ON c.id=m.conversation_id WHERE c.task_id=t.id AND mv.content ILIKE $3)))`;
    const params = [scope.studentId, opts.revisionId ?? null, pattern];
    return inTransaction(this.db, async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const [list, count] = await Promise.all([
        tx.query<TaskDTO>(
          taskSelect +
            ` ${where} ORDER BY t.updated_at DESC,t.id DESC LIMIT $4 OFFSET $5`,
          [...params, opts.limit, opts.offset],
        ),
        tx.query<{ total: number; pageVersion: string }>(
          `SELECT count(*)::int AS total, md5(COALESCE(string_agg(t.id::text || t.updated_at::text || t.version::text || COALESCE(t.title,''), ',' ORDER BY t.id),'')) AS "pageVersion" FROM learning_tasks t ${where}`,
          params,
        ),
      ]);
      return {
        items: list.rows,
        total: count.rows[0]?.total ?? 0,
        pageVersion: count.rows[0]!.pageVersion,
      };
    });
  }
  async rename(
    scope: StudentScope,
    taskId: string,
    input: unknown,
  ): Promise<TaskDTO> {
    const v = taskTitleInput.parse(input);
    await this.resume(scope, taskId);
    await this.db.pool.query(
      "UPDATE learning_tasks SET title=$1 WHERE id=$2 AND student_id=$3 AND deleted_at IS NULL",
      [v.title, taskId, scope.studentId],
    );
    return this.resume(scope, taskId);
  }
  async remove(scope: StudentScope, taskId: string): Promise<void> {
    await this.resume(scope, taskId);
    await this.db.pool.query(
      "UPDATE learning_tasks SET deleted_at=now(),version=version+1 WHERE id=$1 AND student_id=$2 AND deleted_at IS NULL",
      [taskId, scope.studentId],
    );
  }
  async transition(scope: StudentScope, input: unknown): Promise<TaskDTO> {
    const v = z
      .object({
        taskId: z.uuid(),
        expectedVersion: z.number().int().positive(),
        status: z.enum(["active", "paused", "completed", "abandoned"]),
      })
      .strict()
      .parse(input);
    await this.resume(scope, v.taskId);
    await inTransaction(this.db, async (tx) => {
      const locked = (
        await tx.query(
          "SELECT kind,version FROM learning_tasks WHERE id=$1 FOR UPDATE",
          [v.taskId],
        )
      ).rows[0];
      if (
        v.status === "completed" &&
        locked?.version === v.expectedVersion &&
        locked.kind === "daily_practice"
      ) {
        const progress = (
          await tx.query(
            "SELECT count(*)::int AS total,count(*) FILTER (WHERE status <> 'pending')::int AS done FROM task_items WHERE task_id=$1",
            [v.taskId],
          )
        ).rows[0];
        if (progress.total < 5 || progress.done < 5)
          throw new AppError(
            "CONFLICT",
            409,
            "每日5练尚未完成，请先暂停保存进度",
          );
      }
      const result = await tx.query(
        "UPDATE learning_tasks SET status=$1,version=version+1,updated_at=now() WHERE id=$2 AND student_id=$3 AND version=$4 AND status NOT IN ('completed','abandoned') RETURNING id,version",
        [v.status, v.taskId, scope.studentId, v.expectedVersion],
      );
      if (!result.rowCount)
        throw new AppError("CONFLICT", 409, "任务已更新，请刷新后重试");
      if (v.status === "completed")
        await new JobQueue(this.db).enqueue(tx, {
          kind: "learning.summary",
          dedupeKey: `summary:${v.taskId}:${result.rows[0].version}`,
          payload: { taskId: v.taskId },
        });
    });
    return this.resume(scope, v.taskId);
  }
  async addQuestion(
    scope: StudentScope,
    taskId: string,
    input: unknown,
  ): Promise<{ questionVersionId: string }> {
    await this.resume(scope, taskId);
    const v = questionInput.parse(input);
    return inTransaction(this.db, async (tx) => {
      const task = (
        await tx.query("SELECT * FROM learning_tasks WHERE id=$1 FOR UPDATE", [
          taskId,
        ])
      ).rows[0];
      if (task.status !== "active")
        throw new AppError("CONFLICT", 409, "请恢复任务后添加题目");
      if (task.kind === "daily_practice") {
        const count = (
          await tx.query(
            "SELECT count(*)::int AS n FROM task_items WHERE task_id=$1",
            [taskId],
          )
        ).rows[0].n;
        if (count >= 5)
          throw new AppError("CONFLICT", 409, "本次每日5练已安排5题");
      }
      const q = (
        await tx.query(
          "INSERT INTO questions(student_id,revision_id,source_type) VALUES($1,$2,'practice') RETURNING id",
          [scope.studentId, task.revision_id],
        )
      ).rows[0];
      const version = (
        await tx.query(
          "INSERT INTO question_versions(question_id,version_no,stem,reference_answer,knowledge_point) VALUES($1,1,$2,$3,$4) RETURNING id",
          [q.id, v.stem, v.referenceAnswer ?? null, v.knowledgePoint ?? null],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO task_items(task_id,question_version_id,position,role) SELECT $1,$2,COALESCE(MAX(position),-1)+1,$3 FROM task_items WHERE task_id=$1",
        [taskId, version.id, v.role],
      );
      return { questionVersionId: version.id };
    });
  }
  async items(scope: StudentScope, taskId: string) {
    await this.resume(scope, taskId);
    return (
      await this.db.pool.query(
        'SELECT i.id,i.question_version_id AS "questionVersionId",i.position,i.role,i.status,v.stem,v.knowledge_point AS "knowledgePoint" FROM task_items i JOIN question_versions v ON v.id=i.question_version_id WHERE i.task_id=$1 ORDER BY i.position',
        [taskId],
      )
    ).rows;
  }
  async skip(scope: StudentScope, taskId: string, itemId: string) {
    await this.resume(scope, taskId);
    const result = await this.db.pool.query(
      "UPDATE task_items SET status='skipped' WHERE id=$1 AND task_id=$2 AND status='pending' RETURNING id",
      [itemId, taskId],
    );
    if (!result.rowCount) throw new AppError("CONFLICT", 409, "该题已处理");
  }
}
