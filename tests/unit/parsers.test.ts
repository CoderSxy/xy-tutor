import { it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { parseDocument } from "../../apps/server/src/jobs/parsers/pdf-process.js";
async function document(pages: number, text?: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([400, 400]);
    if (text) page.drawText(text, { x: 20, y: 300, font, size: 12 });
  }
  return Buffer.from(await doc.save());
}
it("extracts text with physical page positions", async () => {
  const bytes = await document(2, "Fractions exercise");
  const pages = [];
  for await (const page of parseDocument({
    bytes,
    contentType: "application/pdf",
    signal: new AbortController().signal,
  }))
    pages.push(page);
  expect(pages).toHaveLength(2);
  expect(pages[0]?.text).toContain("Fractions exercise");
  expect(pages[1]?.pdfPageIndex).toBe(1);
});
it("marks scanned pages as needing OCR instead of inventing text", async () => {
  const bytes = await document(1);
  const pages = [];
  for await (const page of parseDocument({
    bytes,
    contentType: "application/pdf",
    signal: new AbortController().signal,
  }))
    pages.push(page);
  expect(pages[0]?.status).toBe("needs_ocr");
  expect(pages[0]?.text).toBe("");
});
it("rejects PDFs over 100 pages and survives malformed input", async () => {
  const collect = async (bytes: Buffer) => {
    for await (const _page of parseDocument({
      bytes,
      contentType: "application/pdf",
      signal: new AbortController().signal,
    })) {
      void _page;
    }
  };
  await expect(collect(await document(101))).rejects.toThrow("PDF_PAGE_LIMIT");
  await expect(collect(Buffer.from("%PDF-broken"))).rejects.toThrow();
});
it("allows a full textbook through an explicit higher page limit while keeping student defaults", async () => {
  const bytes = await document(102, "Textbook page");
  let count = 0;
  for await (const page of parseDocument({
    bytes,
    contentType: "application/pdf",
    maxPages: 500,
    signal: new AbortController().signal,
  })) {
    expect(page.status).toBe("ready");
    count++;
  }
  expect(count).toBe(102);
});
