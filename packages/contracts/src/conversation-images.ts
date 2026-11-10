import { z } from "zod";
import { AppError } from "./api.js";
import type { CapabilityReport } from "./agent.js";

export const MAX_MESSAGE_IMAGES = 3;
export const MAX_IMAGE_BYTES = 5 * 1024 ** 2;
export const MAX_MESSAGE_IMAGE_BYTES = 15 * 1024 ** 2;
export const MAX_SOURCE_IMAGE_BYTES = 15 * 1024 ** 2;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const TARGET_IMAGE_BYTES = 2 * 1024 ** 2;
export const MAX_MESSAGE_TEXT_LENGTH = 20_000;
export const IMAGE_UPLOAD_CONCURRENCY = 2;
export const MAX_MODEL_IMAGES = 6;
export const MAX_MODEL_IMAGE_BYTES = 30 * 1024 ** 2;
export const IMAGE_READ_CONCURRENCY = 2;
export const IMAGE_READ_TIMEOUT_MS = 15_000;
export const IMAGE_BUDGET_TOKENS = 1536;
export const IMAGE_DOWNLOAD_TTL_SECONDS = 300;
export const IMAGE_DRAFT_RETENTION_MS = 24 * 60 * 60 * 1000;

export type ImageAttachmentDTO = {
  fileId: string;
  name: string;
  mimeType: string;
  width: number;
  height: number;
  position: number;
};

export type ImageSubmission = {
  message: string;
  attachmentIds: string[];
  questionVersionId?: string;
};

export const imageSubmissionInput = z
  .object({
    message: z.string().trim().max(MAX_MESSAGE_TEXT_LENGTH).default(""),
    attachmentIds: z
      .array(z.uuid())
      .max(MAX_MESSAGE_IMAGES)
      .default([]),
    questionVersionId: z.uuid().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.message && !value.attachmentIds.length)
      ctx.addIssue({
        code: "custom",
        message: "消息不能为空",
        path: ["message"],
      });
    if (new Set(value.attachmentIds).size !== value.attachmentIds.length)
      ctx.addIssue({
        code: "custom",
        message: "图片不能重复",
        path: ["attachmentIds"],
      });
  });

export function assertImageInputSupported(
  attachmentIds: readonly string[],
  capabilities: Pick<CapabilityReport, "images"> | undefined,
): void {
  if (!attachmentIds.length) return;
  if (capabilities?.images !== "enabled-unverified")
    throw new AppError("VALIDATION", 422, "当前模型不支持图片输入，请仅发送文字");
}
