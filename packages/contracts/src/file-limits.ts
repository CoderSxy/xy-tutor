export const MAX_TEXTBOOK_PAGES = 500;
export const MAX_MATERIAL_PAGES = 100;
export const MAX_TEXTBOOK_PDF_BYTES = 50 * 1024 ** 2;
export const MAX_MATERIAL_PDF_BYTES = 30 * 1024 ** 2;
export function fileTooLarge(
  purpose: "textbook" | "student_material",
  contentType: string,
  size: number,
): boolean {
  if (purpose === "textbook") return size >= MAX_TEXTBOOK_PDF_BYTES;
  return (
    size >
    (contentType === "application/pdf"
      ? MAX_MATERIAL_PDF_BYTES
      : 10 * 1024 ** 2)
  );
}
