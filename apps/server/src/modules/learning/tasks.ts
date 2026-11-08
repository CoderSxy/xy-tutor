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
  type TaskDTO,
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
    const rev = await this.catalog.getRevision(scope.actor, v.revisionId);
    if (rev.status !== "published")
      throw new AppError("CONFLICT", 409, "教材已停用，请选择已发布教材");
    const id = await inTransaction(this.db, async (tx) => {
      if (
        v.chapterId &&
        !(
          await tx.query(
            "SELECT 1 FROM chapters WHERE id=$1 AND revision_id=$2",
            [v.chapterId, v.revisionId],
          )
        ).rowCount
      )
        throw new AppError("NOT_FOUND", 404, "章节不存在");
      const t = (
        await tx.query(
          "INSERT INTO learning_tasks(student_id,revision_id,kind,chapter_id) VALUES($1,$2,$3,$4) RETURNING id",
          [scope.studentId, v.revisionId, v.kind, v.chapterId ?? null],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO conversations(student_id,task_id,revision_id) VALUES($1,$2,$3)",
        [scope.studentId, t.id, v.revisionId],
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
        taskSelect + " WHERE t.id=$1 AND t.student_id=$2",
        [id, scope.studentId],
      )
    ).rows[0];
    if (!task) throw new AppError("NOT_FOUND", 404, "任务不存在");
    return task;
  }
  async list(scope: StudentScope): Promise<TaskDTO[]> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    return (
      await this.db.pool.query<TaskDTO>(
        taskSelect +
          " WHERE t.student_id=$1 ORDER BY t.updated_at DESC LIMIT 100",
        [scope.studentId],
      )
    ).rows;
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
