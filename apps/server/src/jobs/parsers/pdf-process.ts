import {
  MAX_TEXTBOOK_PAGES,
  MAX_MATERIAL_PAGES,
  MAX_OCR_PAGES,
  MAX_TEXTBOOK_PDF_BYTES,
  MAX_MATERIAL_PDF_BYTES,
} from "../../../../../packages/contracts/src/file-limits.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { imageSize } from "image-size";
import { z } from "zod";
import { toJobError } from "../errors.js";
import type { OcrProvider } from "./ocr.js";
export type ParsedPage = {
  pdfPageIndex: number;
  printedPageLabel?: string;
  text: string;
  status: "ready" | "needs_ocr" | "failed";
  imageBase64?: string;
  imageType?: string;
};
const pageSchema = z.object({
  pdfPageIndex: z.number().int().nonnegative(),
  printedPageLabel: z.string().optional(),
  text: z.string().max(200000),
  status: z.enum(["ready", "needs_ocr", "failed"]),
  imageBase64: z.string().max(10000000).optional(),
  imageType: z.string().max(40).optional(),
});
// 单页输出超过 30 秒没有新行就认为子进程卡住。
const PAGE_STALL_MS = 30_000;
// 整份文档的硬上限。没有它，一个每页都“有进展”的扫描件可以永远跑下去。
export const PARSE_DEADLINE_MS = 10 * 60_000;
export async function* parseDocument(input: {
  /** 直接给字节（测试用）；生产走 read，让缓冲区在写盘后立即释放。 */
  bytes?: Buffer;
  read?: () => Promise<Buffer>;
  contentType: string;
  signal: AbortSignal;
  ocr?: OcrProvider;
  maxPages?: number;
  maxBytes?: number;
  maxOcrPages?: number;
}): AsyncGenerator<ParsedPage> {
  input.signal.throwIfAborted();
  const maxBytes = z
    .number()
    .int()
    .min(1)
    .max(MAX_TEXTBOOK_PDF_BYTES - 1)
    .parse(input.maxBytes ?? MAX_MATERIAL_PDF_BYTES);
  if (input.contentType !== "application/pdf") {
    const bytes = input.bytes ?? (await input.read?.());
    if (!bytes) throw Error("MISSING_INPUT");
    if (bytes.length > maxBytes) throw Error("FILE_SIZE_LIMIT");
    const dimensions = imageSize(bytes);
    if (
      !dimensions.width ||
      !dimensions.height ||
      dimensions.width * dimensions.height > 20000000
    )
      throw Error("IMAGE_PIXEL_LIMIT");
    const recognized = input.ocr
      ? await input.ocr.recognize({ bytes, contentType: input.contentType }, input.signal)
      : undefined;
    yield {
      pdfPageIndex: 0,
      text: recognized?.text ?? "",
      status: recognized ? "ready" : "needs_ocr",
    };
    return;
  }
  const maxPages = z
    .number()
    .int()
    .min(1)
    .max(MAX_TEXTBOOK_PAGES)
    .parse(input.maxPages ?? MAX_MATERIAL_PAGES);
  const maxOcrPages = z
    .number()
    .int()
    .min(0)
    .max(MAX_OCR_PAGES)
    .parse(input.maxOcrPages ?? MAX_OCR_PAGES);
  const dir = await mkdtemp(join(tmpdir(), "xy-tutor-parse-"));
  const path = join(dir, "document.pdf");
  const compiled = fileURLToPath(new URL("./pdf-child.js", import.meta.url));
  const source = fileURLToPath(new URL("./pdf-child.ts", import.meta.url));
  const script = existsSync(compiled) ? compiled : source;
  const args = [
    "--max-old-space-size=256",
    ...(script.endsWith(".ts") ? ["--import", "tsx"] : []),
    script,
    path,
    input.ocr ? "render" : "text",
    String(maxPages),
    String(maxOcrPages),
  ];
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let failure: Error | undefined;
  let timedOut = false;
  let stalled = false;
  try {
    {
      // 缓冲区只在这一段里存活：写盘之后立刻放开引用，别让它陪着整份文档跑完。
      const bytes = input.bytes ?? (await input.read?.());
      if (!bytes) throw Error("MISSING_INPUT");
      if (bytes.length > maxBytes) throw Error("FILE_SIZE_LIMIT");
      await writeFile(path, bytes, { mode: 0o600 });
    }
    const proc = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal: input.signal,
    });
    child = proc as ChildProcessByStdio<null, Readable, Readable>;
    proc.stderr.resume();
    const exited = new Promise<void>((resolve) => {
      proc.once("error", (error) => {
        failure = error;
        resolve();
      });
      proc.once("close", (code) => {
        if (code !== 0) failure ??= Error("PDF_PARSE_FAILED");
        resolve();
      });
    });
    const deadline = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, PARSE_DEADLINE_MS);
    let timer = setTimeout(() => {
      stalled = true;
      proc.kill("SIGKILL");
    }, PAGE_STALL_MS);
    try {
      for await (const line of createInterface({ input: proc.stdout })) {
        if (line.length > 11000000) throw toJobError("PARSE_OUTPUT_LIMIT");
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (value && typeof value === "object" && "error" in value)
          throw toJobError(String(value.error));
        const result = pageSchema.safeParse(value);
        if (!result.success) continue;
        clearTimeout(timer);
        timer = setTimeout(() => {
          stalled = true;
          proc.kill("SIGKILL");
        }, PAGE_STALL_MS);
        const page = result.data;
        if (page.imageBase64 && input.ocr) {
          const recognized = await input.ocr.recognize(
            {
              bytes: Buffer.from(page.imageBase64, "base64"),
              contentType: page.imageType ?? "image/jpeg",
            },
            input.signal,
          );
          page.text = recognized.text;
          page.status = "ready";
          delete page.imageBase64;
        }
        delete page.imageBase64;
        yield page;
      }
      await exited;
      if (timedOut) throw toJobError("PARSE_TIMEOUT");
      if (stalled) throw toJobError("PARSE_STALLED");
      if (failure) throw failure;
    } finally {
      clearTimeout(deadline);
      clearTimeout(timer);
    }
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}
