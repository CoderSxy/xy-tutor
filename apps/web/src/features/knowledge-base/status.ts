import type {
  KnowledgeItemStatus,
  ParseRunStatus,
} from "../../../../../packages/contracts/src/knowledge-base.js";

export const knowledgeStatus: Record<KnowledgeItemStatus, string> = {
  pending_review: "待确认",
  published: "已发布",
  discarded: "已丢弃",
};

export const knowledgeRunStatus: Record<ParseRunStatus, string> = {
  queued: "排队中",
  processing: "解析中",
  succeeded: "解析完成",
  failed: "解析失败",
};

export const REPARSE_SUBMITTED =
  "已提交再解析，重新解析完成前保留已发布内容。";

export function knowledgeParseError(code?: string | null): string {
  const reasons: Record<string, string> = {
    MODEL_NOT_CONFIGURED: "尚未配置模型，暂时无法解析知识点。",
    INVALID_KNOWLEDGE_RUN: "解析任务已失效，请重新发起解析。",
    INVALID_KNOWLEDGE_SOURCE:
      "资料文件尚未就绪或无法读取，请重新上传后解析。",
    EMPTY_KNOWLEDGE_SOURCE: "资料中没有可提取的内容，请补充文本或更换文件。",
    OSS_NOT_CONFIGURED: "文件存储尚未配置，暂时无法读取资料文件。",
    PARSE_INVALID_OUTPUT: "解析结果格式不正确，请调整提示词后重试。",
    PROCESSING_FAILED: "解析未完成，请重试；若仍失败，请检查资料内容。",
    INTERRUPTED: "解析被中断，请重新解析。",
  };
  return reasons[code ?? ""] ?? "解析未完成，请重试；若仍失败，请检查资料内容。";
}
