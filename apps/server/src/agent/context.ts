import { AppError } from "../../../../packages/contracts/src/api.js";
import { SummaryService } from "../modules/learning/summaries.js";
import { KnowledgeService } from "../modules/learning/knowledge.js";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { Database } from "../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../packages/contracts/src/domain.js";
import { MessageService } from "../modules/conversations/messages.js";
import type { MessageHistory } from "../modules/conversations/contracts.js";
import type { AuthService } from "../modules/auth/service.js";
import type { CatalogService } from "../modules/catalog/service.js";
import type {
  ImageEvidenceReader,
  LoadedImage,
} from "../modules/conversations/attachments.js";
import {
  IMAGE_BUDGET_TOKENS,
  MAX_MODEL_IMAGE_BYTES,
  MAX_MODEL_IMAGES,
} from "../../../../packages/contracts/src/conversation-images.js";
export type BuildContextOptions = {
  reader?: ImageEvidenceReader;
  inputVersionId?: string | null;
  signal?: AbortSignal;
  perImageTokens?: number;
  imageBudgetTokens?: number;
};
export type TutorContext = {
  systemContext: string;
  messages: Message[];
  taskId: string | null;
  revisionId?: string;
  studentId: string;
  currentQuestionVersionId?: string;
  inputContent?: (TextContent | ImageContent)[];
  inputMatched: boolean;
  imageCount: number;
};

function imageBlocks(images: readonly LoadedImage[]): ImageContent[] {
  return images.map((image) => ({
    type: "image",
    data: image.data,
    mimeType: image.mimeType,
  }));
}

function userContent(
  text: string,
  images: readonly LoadedImage[],
): string | (TextContent | ImageContent)[] {
  if (!images.length) return text;
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...imageBlocks(images),
  ];
}
export async function buildContext(
  db: Database,
  auth: AuthService,
  catalog: CatalogService,
  scope: StudentScope,
  conversationId: string,
  budgetTokens: number,
  options: BuildContextOptions = {},
): Promise<TutorContext> {
  const ms = new MessageService(db, auth);
  await ms.authorize(scope, conversationId);
  const c = (
    await db.pool.query("SELECT * FROM conversations WHERE id=$1", [
      conversationId,
    ])
  ).rows[0];
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
    学生: profile,
    知识点检索说明:
      "按学生问题调用 search_knowledge 检索已发布知识点，只引用工具实际返回的条目 ID、标题和总结；没有命中时说明依据不足。",
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
  const perImageTokens = options.perImageTokens ?? IMAGE_BUDGET_TOKENS;
  const history = await ms.history(scope, conversationId);
  const inputIndex = options.inputVersionId
    ? history.findIndex(
        (message) => message.versionId === options.inputVersionId,
      )
    : -1;
  const input = inputIndex >= 0 ? history[inputIndex] : undefined;
  let inputImages: LoadedImage[] = [];
  if (input?.attachments.length) {
    if (!options.reader)
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        503,
        "图片读取功能尚未配置，请联系管理员",
      );
    inputImages = await options.reader.load(
      input.attachments.map((attachment) => attachment.fileId),
      options.signal,
    );
  }
  const imageBudget = options.imageBudgetTokens ?? Number.POSITIVE_INFINITY;
  let imageCount = inputImages.length;
  let imageTokens = inputImages.length * perImageTokens;
  let imageBytes = inputImages.reduce((total, image) => total + image.size, 0);
  if (
    imageCount > MAX_MODEL_IMAGES ||
    imageBytes > MAX_MODEL_IMAGE_BYTES ||
    imageTokens > imageBudget
  )
    throw new AppError(
      "VALIDATION",
      422,
      "当前题目或提示过长，请分段学习或选择更小的题目范围",
    );
  let remaining =
    budgetTokens - Buffer.byteLength(systemContext) - 2500 - imageTokens;
  const inputCost = Buffer.byteLength(input?.content ?? "");
  if (inputCost > remaining)
    throw new AppError(
      "VALIDATION",
      422,
      "当前题目或提示过长，请分段学习或选择更小的题目范围",
    );
  remaining -= inputCost;
  const selected: Message[] = [];
  for (let index = history.length - 1; index >= 0; index--) {
    if (index === inputIndex) continue;
    const message = history[index]!;
    const attachments = message.attachments ?? [];
    const cost =
      Buffer.byteLength(message.content) + attachments.length * perImageTokens;
    if (cost > remaining) break;
    if (imageCount + attachments.length > MAX_MODEL_IMAGES) break;
    if (imageTokens + attachments.length * perImageTokens > imageBudget) break;
    let loaded: LoadedImage[] = [];
    if (attachments.length) {
      if (!options.reader)
        throw new AppError(
          "UPSTREAM_UNAVAILABLE",
          503,
          "图片读取功能尚未配置，请联系管理员",
        );
      loaded = await options.reader.load(
        attachments.map((attachment) => attachment.fileId),
        options.signal,
      );
    }
    const nextImageBytes =
      imageBytes + loaded.reduce((total, image) => total + image.size, 0);
    if (nextImageBytes > MAX_MODEL_IMAGE_BYTES) break;
    remaining -= cost;
    imageCount += loaded.length;
    imageTokens += loaded.length * perImageTokens;
    imageBytes = nextImageBytes;
    selected.unshift(historyMessage(message, loaded));
  }
  return {
    systemContext,
    messages: selected,
    taskId: c.task_id,
    ...(c.revision_id ? { revisionId: c.revision_id as string } : {}),
    studentId: c.student_id,
    currentQuestionVersionId: current?.question_version_id,
    inputContent:
      input && inputImages.length
        ? (userContent(input.content, inputImages) as (
            TextContent | ImageContent
          )[])
        : undefined,
    inputMatched: inputIndex >= 0,
    imageCount,
  };
}

function historyMessage(
  message: MessageHistory,
  images: readonly LoadedImage[],
): Message {
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content:
      message.role === "assistant"
        ? [{ type: "text", text: message.content }]
        : userContent(message.content, images),
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
  } as Message;
}
