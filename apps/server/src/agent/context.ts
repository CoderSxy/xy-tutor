import { AppError } from "../../../../packages/contracts/src/api.js";
import { SummaryService } from "../modules/learning/summaries.js";
import { KnowledgeService } from "../modules/learning/knowledge.js";
import type { Message } from "@earendil-works/pi-ai";
import type { Database } from "../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../packages/contracts/src/domain.js";
import { MessageService } from "../modules/conversations/messages.js";
import type { AuthService } from "../modules/auth/service.js";
import type { CatalogService } from "../modules/catalog/service.js";
export type TutorContext = {
  systemContext: string;
  messages: Message[];
  taskId: string | null;
  revisionId: string;
  studentId: string;
  currentQuestionVersionId?: string;
};
export async function buildContext(
  db: Database,
  auth: AuthService,
  catalog: CatalogService,
  scope: StudentScope,
  conversationId: string,
  budgetTokens: number,
): Promise<TutorContext> {
  const ms = new MessageService(db, auth);
  await ms.authorize(scope, conversationId);
  const c = (
    await db.pool.query("SELECT * FROM conversations WHERE id=$1", [
      conversationId,
    ])
  ).rows[0];
  const revision = await catalog.getRevision(scope.actor, c.revision_id);
  const profile = await auth.getProfile(scope);
  const items = c.task_id
    ? (
        await db.pool.query(
          "SELECT i.question_version_id,i.status,i.role,v.stem,v.knowledge_point FROM task_items i JOIN question_versions v ON v.id=i.question_version_id WHERE i.task_id=$1 ORDER BY i.position",
          [c.task_id],
        )
      ).rows
    : [];
  const hints = c.task_id
    ? (
        await db.pool.query(
          "SELECT h.question_version_id,h.level,v.content FROM hints h JOIN message_versions v ON v.id=h.message_version_id WHERE h.task_id=$1 ORDER BY h.displayed_at DESC LIMIT 10",
          [c.task_id],
        )
      ).rows
    : [];
  const task = c.task_id
    ? (
        await db.pool.query(
          "SELECT kind,chapter_id,status FROM learning_tasks WHERE id=$1",
          [c.task_id],
        )
      ).rows[0]
    : null;
  const current = items.find((i) => i.status === "pending") ?? items.at(-1);
  const attempts = c.task_id
    ? (
        await db.pool.query(
          'SELECT id,question_version_id AS "questionVersionId",answer,created_at AS "createdAt" FROM attempts WHERE task_id=$1 AND student_id=$2 ORDER BY created_at DESC LIMIT 5',
          [c.task_id, scope.studentId],
        )
      ).rows
    : [];
  const summaries = await new SummaryService(db, auth).relevant(
    scope,
    c.revision_id,
  );
  const knowledge = await new KnowledgeService(db, auth).get(
    scope,
    c.revision_id,
  );
  const systemContext = JSON.stringify({
    教材: revision,
    学生: profile,
    任务: task,
    当前题目: current,
    提示历史: hints,
    最近作答: attempts,
    相关摘要: summaries.map((s) => ({
      taskId: s.taskId,
      text: s.content.text.slice(0, 1000),
      evidence: s.content.evidence.slice(0, 10),
    })),
    当前学情: knowledge,
    进度: profile.preferences.currentChapter ?? "未知，需要询问",
  });
  if (Buffer.byteLength(systemContext) > budgetTokens - 2500)
    throw new AppError(
      "VALIDATION",
      422,
      "当前题目或提示过长，请分段学习或选择更小的题目范围",
    );
  let remaining = Math.max(
    0,
    budgetTokens - Buffer.byteLength(systemContext) - 2500,
  );
  const history = await ms.history(scope, conversationId);
  const selected: Message[] = [];
  for (const message of history.slice().reverse()) {
    const bytes = Buffer.byteLength(message.content);
    if (bytes > remaining) break;
    remaining -= bytes;
    selected.unshift({
      role: message.role === "assistant" ? "assistant" : "user",
      content:
        message.role === "assistant"
          ? [{ type: "text", text: message.content }]
          : message.content,
      timestamp: Date.now(),
      ...(message.role === "assistant"
        ? {
            api: "openai-completions",
            provider: "history",
            model: "history",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
          }
        : {}),
    } as Message);
  }
  return {
    systemContext,
    messages: selected,
    taskId: c.task_id,
    revisionId: c.revision_id,
    studentId: c.student_id,
    currentQuestionVersionId: current?.question_version_id,
  };
}
