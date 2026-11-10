import { MAX_SOURCE_IMAGE_BYTES } from "./conversation-images.js";
export const MAX_TEXTBOOK_PAGES = 500;
export const MAX_MATERIAL_PAGES = 100;
// 扫描页每页都要渲染加 OCR，内存与耗时随页数线性增长；单进程解析不能超过这个量。
export const MAX_OCR_PAGES = 60;
export const MAX_TEXTBOOK_PDF_BYTES = 50 * 1024 ** 2;
export const MAX_MATERIAL_PDF_BYTES = 30 * 1024 ** 2;
export function fileTooLarge(
  purpose:
    | "textbook"
    | "student_material"
    | "conversation_image"
    | "knowledge_source",
  contentType: string,
  size: number,
): boolean {
  if (purpose === "textbook") return size >= MAX_TEXTBOOK_PDF_BYTES;
  if (purpose === "conversation_image")
    return size > MAX_SOURCE_IMAGE_BYTES;
  if (purpose === "knowledge_source")
    return (
      size >=
      (contentType === "application/pdf"
        ? MAX_MATERIAL_PDF_BYTES
        : 10 * 1024 ** 2)
    );
  return (
    size >
    (contentType === "application/pdf"
      ? MAX_MATERIAL_PDF_BYTES
      : 10 * 1024 ** 2)
  );
}
