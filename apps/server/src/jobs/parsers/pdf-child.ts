import {
  MAX_TEXTBOOK_PAGES,
  MAX_MATERIAL_PAGES,
  MAX_OCR_PAGES,
} from "../../../../../packages/contracts/src/file-limits.js";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
const path = process.argv[2];
if (!path) throw Error("Missing private input");
const PASSTHROUGH = new Set([
  "PDF_PAGE_LIMIT",
  "OCR_PAGE_LIMIT",
  "IMAGE_PIXEL_LIMIT",
  "PARSE_OUTPUT_LIMIT",
]);
let loadingTask: ReturnType<typeof getDocument> | undefined;
try {
  const file = await readFile(path);
  // 不复制：pdfjs 只读这块内存，多一份 50MB 的拷贝在这里没有意义。
  const data = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
  loadingTask = getDocument({ data, useSystemFonts: true });
  const doc = await loadingTask.promise;
  const maxPages = Number(process.argv[4] ?? MAX_MATERIAL_PAGES);
  if (
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > MAX_TEXTBOOK_PAGES ||
    doc.numPages > maxPages
  )
    throw Error("PDF_PAGE_LIMIT");
  const maxOcrPages = Number(process.argv[5] ?? MAX_OCR_PAGES);
  if (!Number.isInteger(maxOcrPages) || maxOcrPages < 0)
    throw Error("OCR_PAGE_LIMIT");
  const labels = await doc.getPageLabels();
  let rendered = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .trim();
    let imageBase64: string | undefined;
    let imageType: string | undefined;
    if (!text && process.argv[3] === "render") {
      // 渲染是最贵的一步：先数再画，超限直接终止，别把内存花在注定要丢的页上。
      if (++rendered > maxOcrPages) throw Error("OCR_PAGE_LIMIT");
      const original = page.getViewport({ scale: 1 });
      if (original.width * original.height > 20000000)
        throw Error("IMAGE_PIXEL_LIMIT");
      const viewport = page.getViewport({
        scale: Math.min(2, 1600 / Math.max(original.width, original.height)),
      });
      const canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: canvas.getContext(
          "2d",
        ) as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      imageType = "image/jpeg";
      imageBase64 = canvas.toBuffer("image/jpeg", 85).toString("base64");
    }
    const ok = process.stdout.write(
      JSON.stringify({
        pdfPageIndex: i - 1,
        printedPageLabel: labels?.[i - 1],
        text,
        status: text ? "ready" : "needs_ocr",
        imageBase64,
        imageType,
      }) + "\n",
    );
    // 父进程在跑 OCR 时不会读管道；不等待 drain，这里会一直往内核缓冲里堆。
    if (!ok) await once(process.stdout, "drain");
    page.cleanup();
  }
} catch (error) {
  if (process.env.DEBUG_PARSER) console.error(error);
  const code =
    error instanceof Error && PASSTHROUGH.has(error.message)
      ? error.message
      : "PDF_PARSE_FAILED";
  process.stdout.write(JSON.stringify({ error: code }) + "\n");
  process.exitCode = 1;
} finally {
  await loadingTask?.destroy().catch(() => {});
}
