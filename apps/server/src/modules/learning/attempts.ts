import { z } from "zod";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { AuthService } from "../auth/service.js";
export type AttemptDTO = {
  id: string;
  answer: string;
  questionVersionId: string;
  taskId: string;
  messageVersionId: string;
};
export class AttemptService {
  constructor(
    private db: Database,
    private auth: AuthService,
  ) {}
  async submit(scope: StudentScope, input: unknown): Promise<AttemptDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const v = z
      .object({
        requestKey: z.string().min(1).max(120),
        taskId: z.uuid(),
        questionVersionId: z.uuid(),
        answer: z.string().trim().min(1).max(20000),
        messageVersionId: z.uuid(),
      })
      .strict()
      .parse(input);
    return inTransaction(this.db, async (tx) => {
      const task = (
        await tx.query(
          "SELECT * FROM learning_tasks WHERE id=$1 AND student_id=$2 FOR UPDATE",
          [v.taskId, scope.studentId],
        )
      ).rows[0];
      if (!task) throw new AppError("NOT_FOUND", 404, "任务不存在");
      const previous = (
        await tx.query(
          'SELECT id,answer,question_version_id AS "questionVersionId",task_id AS "taskId",message_version_id AS "messageVersionId" FROM attempts WHERE student_id=$1 AND request_key=$2',
          [scope.studentId, v.requestKey],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.answer !== v.answer ||
          previous.questionVersionId !== v.questionVersionId ||
          previous.taskId !== v.taskId ||
          previous.messageVersionId !== v.messageVersionId
        )
          throw new AppError("CONFLICT", 409, "重复作答请求内容不同");
        return previous;
      }
      if (task.status !== "active")
        throw new AppError("CONFLICT", 409, "请先恢复学习任务");
      const q = (
        await tx.query(
          "SELECT i.id FROM task_items i JOIN question_versions v ON v.id=i.question_version_id JOIN questions q ON q.id=v.question_id WHERE i.task_id=$1 AND i.question_version_id=$2 AND (q.student_id=$3 OR q.student_id IS NULL) AND q.revision_id=$4",
          [v.taskId, v.questionVersionId, scope.studentId, task.revision_id],
        )
      ).rows[0];
      const message = (
        await tx.query(
          "SELECT v.content FROM message_versions v JOIN messages m ON m.id=v.message_id JOIN conversations c ON c.id=m.conversation_id WHERE v.id=$1 AND c.task_id=$2 AND c.student_id=$3 AND m.role='user'",
          [v.messageVersionId, v.taskId, scope.studentId],
        )
      ).rows[0];
      if (!q || !message)
        throw new AppError("NOT_FOUND", 404, "作答题目或消息不存在");
      if (message.content.trim() !== v.answer)
        throw new AppError("VALIDATION", 422, "作答与原始消息不一致");
      const a = (
        await tx.query(
          "INSERT INTO attempts(student_id,task_id,question_version_id,message_version_id,request_key,answer) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
          [
            scope.studentId,
            v.taskId,
            v.questionVersionId,
            v.messageVersionId,
            v.requestKey,
            v.answer,
          ],
        )
      ).rows[0];
      await tx.query("UPDATE task_items SET status='answered' WHERE id=$1", [
        q.id,
      ]);
      return {
        id: a.id,
        answer: v.answer,
        questionVersionId: v.questionVersionId,
        taskId: v.taskId,
        messageVersionId: v.messageVersionId,
      };
    });
  }
  async get(scope: StudentScope, id: string) {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    z.uuid().parse(id);
    const row = (
      await this.db.pool.query(
        'SELECT a.id,a.answer,a.question_version_id,a.message_version_id,a.created_at,v.stem AS "questionStem",mv.content AS "messageContent" FROM attempts a JOIN question_versions v ON v.id=a.question_version_id LEFT JOIN message_versions mv ON mv.id=a.message_version_id WHERE a.id=$1 AND a.student_id=$2',
        [id, scope.studentId],
      )
    ).rows[0];
    if (!row) throw new AppError("NOT_FOUND", 404, "作答不存在");
    const hints = (
      await this.db.pool.query(
        "SELECT h.level,v.content FROM hints h JOIN message_versions v ON v.id=h.message_version_id WHERE h.question_version_id=$1 AND h.displayed_at<=$2 ORDER BY h.displayed_at",
        [row.question_version_id, row.created_at],
      )
    ).rows;
    const attachments = row.message_version_id
      ? (
          await this.db.pool.query(
            'SELECT f.id AS "fileId",f.name,f.content_type AS "mimeType",f.width,f.height,ma.position FROM message_attachments ma JOIN files f ON f.id=ma.file_id WHERE ma.message_version_id=$1 ORDER BY ma.position',
            [row.message_version_id],
          )
        ).rows
      : [];
    return {
      id: row.id,
      answer: row.answer,
      questionStem: row.questionStem,
      messageContent: row.messageContent,
      hints,
      attachments,
    };
  }
}
