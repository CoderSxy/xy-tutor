import type {
  KnowledgeItemStatus,
  ParseRunStatus,
} from "../../../../../packages/contracts/src/knowledge-base.js";

export const knowledgeStatus: Record<KnowledgeItemStatus, string> = {
  pending_review: "待确认",
  published: "已发布",
  discarded: "已丢弃",
  withdrawn: "已撤回",
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
    OCR_UNAVAILABLE: "扫描件识别失败，请检查 OCR 是否已配置，或改用带文字的 PDF、TXT。",
    PDF_PARSE_FAILED: "无法读取该 PDF，请检查文件是否损坏或加密。",
    PDF_PAGE_LIMIT: "PDF 页数过多，请拆分后重新上传。",
    FILE_SIZE_LIMIT: "文件超过大小限制，请压缩或拆分后重新上传。",
    PARSE_TIMEOUT: "解析超时，请拆分资料后重试。",
    PARSE_STALLED: "解析长时间无响应，请检查文件后重试。",
    IMAGE_PIXEL_LIMIT: "图片尺寸过大，请压缩后重试。",
    OCR_IMAGE_LIMIT: "扫描图片超过识别限制，请压缩后重试。",
    PARSE_OUTPUT_LIMIT: "单页解析结果过大，请拆分资料后重试。",
    INTERRUPTED: "解析被中断，请重新解析。",
  };
  return reasons[code ?? ""] ?? "解析未完成，请重试；若仍失败，请检查资料内容。";
}
