import { z } from "zod";
export const taskInput = z
  .object({
    revisionId: z.uuid(),
    kind: z.enum([
      "daily_practice",
      "knowledge_consolidation",
      "mistake_review",
      "material_tutoring",
      "free_question",
    ]),
    chapterId: z.uuid().optional(),
  })
  .strict();
export type TaskKind = z.infer<typeof taskInput>["kind"];
export type TaskDTO = {
  id: string;
  studentId: string;
  revisionId: string;
  kind: TaskKind;
  title: string | null;
  status: "active" | "paused" | "completed" | "abandoned";
  version: number;
  conversationId: string;
  chapterId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type TaskPage = { items: TaskDTO[]; total: number; pageVersion: string };
export const taskSelect = `SELECT t.id,t.student_id AS "studentId",t.revision_id AS "revisionId",t.kind,t.title,t.status,t.version,t.chapter_id AS "chapterId",t.created_at AS "createdAt",t.updated_at AS "updatedAt",(SELECT id FROM conversations WHERE task_id=t.id ORDER BY created_at DESC LIMIT 1) AS "conversationId" FROM learning_tasks t`;
export const taskTitleInput = z
  .object({ title: z.string().trim().min(1).max(80) })
  .strict();
export const questionInput = z
  .object({
    stem: z.string().trim().min(1).max(20000),
    referenceAnswer: z.string().max(10000).optional(),
    knowledgePoint: z.string().max(200).optional(),
    role: z.enum(["original", "variant", "diagnostic"]),
  })
  .strict();
