import { z } from "zod";

export const KNOWLEDGE_ITEM_STATUSES = [
  "pending_review",
  "published",
  "discarded",
] as const;
export const PARSE_RUN_STATUSES = [
  "queued",
  "processing",
  "succeeded",
  "failed",
] as const;

export const KNOWLEDGE_SOURCE_CONTENT_TYPES = [
  "text/plain",
  "text/markdown",
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type KnowledgeItemStatus = (typeof KNOWLEDGE_ITEM_STATUSES)[number];
export type ParseRunStatus = (typeof PARSE_RUN_STATUSES)[number];

export type KnowledgeItemDTO = {
  id: string;
  batchId: string;
  parseRunId: string;
  title: string;
  summary: string;
  status: KnowledgeItemStatus;
  replacesItemId: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeParseRunDTO = {
  id: string;
  batchId: string;
  extraPrompt: string | null;
  model: string | null;
  status: ParseRunStatus;
  errorCode: string | null;
  itemCount: number;
  createdAt: string;
  completedAt: string | null;
};

export type KnowledgeBatchDTO = {
  id: string;
  textContent: string | null;
  files: { fileId: string; name: string; contentType: string }[];
  latestRun: KnowledgeParseRunDTO | null;
  pendingCount: number;
  publishedCount: number;
  createdAt: string;
};

export type KnowledgeSearchHit = {
  id: string;
  title: string;
  summary: string;
};

export const createBatchInput = z
  .object({
    text: z.string().trim().max(50_000).optional(),
    fileIds: z.array(z.uuid()).max(10).default([]),
    extraPrompt: z.string().trim().max(4000).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.text) || v.fileIds.length > 0, {
    message: "请提供文本或文件",
  });

export const editItemInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(20_000),
  })
  .strict();

export const reparseInput = z
  .object({
    extraPrompt: z.string().trim().min(1).max(4000),
    replacesItemId: z.uuid().optional(),
  })
  .strict();

export const searchInput = z
  .object({
    keywords: z.string().trim().min(1).max(255),
    limit: z.number().int().min(1).max(8).default(5),
  })
  .strict();

export type CreateBatchInput = z.infer<typeof createBatchInput>;
export type EditItemInput = z.infer<typeof editItemInput>;
export type ReparseInput = z.infer<typeof reparseInput>;
export type SearchInput = z.infer<typeof searchInput>;
