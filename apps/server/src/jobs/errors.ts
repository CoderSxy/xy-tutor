// 重试不会变好的失败：页数超限、扫描页超限、整体超时。
// 队列遇到它直接置为 failed，不再排 10 秒后重跑一遍同样的文件。
export class PermanentJobError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PermanentJobError";
  }
}

export const PERMANENT_CODES = new Set([
  "PDF_PAGE_LIMIT",
  "OCR_PAGE_LIMIT",
  "IMAGE_PIXEL_LIMIT",
  "FILE_SIZE_LIMIT",
  "PARSE_OUTPUT_LIMIT",
  "PARSE_TIMEOUT",
  "PARSE_STALLED",
  "QUESTION_LIMIT",
  "INVALID_TEXTBOOK_FILE",
  "INVALID_MATERIAL",
]);

export function toJobError(code: string): Error {
  return PERMANENT_CODES.has(code) ? new PermanentJobError(code) : Error(code);
}
