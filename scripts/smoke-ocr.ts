import { readFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import { imageSize } from "image-size";
import { createOcr } from "../apps/server/src/jobs/parsers/ocr.js";
try {
  const provider = createOcr(process.env);
  if (!provider) throw Error("OCR_NOT_CONFIGURED");
  let bytes: Buffer, contentType: string;
  if (process.env.OCR_SMOKE_FILE) {
    bytes = await readFile(process.env.OCR_SMOKE_FILE);
    const image = imageSize(bytes);
    contentType =
      image.type === "jpg"
        ? "image/jpeg"
        : image.type === "png"
          ? "image/png"
          : image.type === "webp"
            ? "image/webp"
            : "";
    if (
      !contentType ||
      !image.width ||
      !image.height ||
      image.width * image.height > 20000000
    )
      throw Error("INVALID_TEST_IMAGE");
  } else {
    const canvas = createCanvas(700, 180);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 700, 180);
    ctx.fillStyle = "#000000";
    ctx.font = "48px sans-serif";
    ctx.fillText("OCR TEST 123", 35, 110);
    bytes = canvas.toBuffer("image/png");
    contentType = "image/png";
  }
  const result = await provider.recognize(
    { bytes, contentType },
    AbortSignal.timeout(30000),
  );
  const expected =
    process.env.OCR_SMOKE_EXPECT ??
    (process.env.OCR_SMOKE_FILE ? "" : "OCR TEST 123");
  const normalize = (text: string) => text.replace(/\s+/g, "").toUpperCase();
  if (
    !result.text.trim() ||
    (expected && !normalize(result.text).includes(normalize(expected)))
  )
    throw Error("OCR_RESULT_MISMATCH");
  console.log(
    `OCR verified on one image (${result.text.length} characters); recognition text and credentials are not logged.`,
  );
} catch {
  console.error(
    "UNVERIFIED: OCR probe failed or is not configured. Check local .env, RAM ocr:RecognizeAllText permission, quota and image; see docs/runbooks/external-services.md.",
  );
  process.exitCode = 1;
}
