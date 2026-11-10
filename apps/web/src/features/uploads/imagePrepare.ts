import { fileTooLarge } from "../../../../../packages/contracts/src/file-limits.js";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  TARGET_IMAGE_BYTES,
} from "../../../../../packages/contracts/src/conversation-images.js";

export const CHAT_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const CHAT_IMAGE_ACCEPT = ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp";

export type PreparedImage = {
  blob: Blob;
  mimeType: "image/jpeg";
  width: number;
  height: number;
};

function decodeError() {
  return Error("无法读取这张图片，请重新拍摄或转换为 JPG/PNG 后重试");
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw decodeError();
  }
}

function checkedAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

async function render(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  rotation: number,
  quality: number,
  whiteBackground: boolean,
): Promise<{ blob: Blob; width: number; height: number }> {
  const sideways = rotation % 180 !== 0;
  const canvas = document.createElement("canvas");
  canvas.width = sideways ? height : width;
  canvas.height = sideways ? width : height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw Error("浏览器无法处理图片");
  if (whiteBackground) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(bitmap, -width / 2, -height / 2, width, height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(Error("照片处理失败，请重试")),
      "image/jpeg",
      quality,
    ),
  );
  return { blob, width: canvas.width, height: canvas.height };
}

export async function prepareChatImage(
  file: File,
  rotation = 0,
  signal?: AbortSignal,
): Promise<PreparedImage> {
  if (!(CHAT_IMAGE_TYPES as readonly string[]).includes(file.type))
    throw Error("请选择 JPG、PNG 或 WebP 图片");
  if (fileTooLarge("conversation_image", file.type, file.size))
    throw Error("照片超过 15MB，请先压缩或裁剪后重试");
  const bitmap = await decode(file);
  try {
    checkedAbort(signal);
    if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS)
      throw Error("照片像素过大，请先裁剪后上传");
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    let width = Math.max(1, Math.round(bitmap.width * scale));
    let height = Math.max(1, Math.round(bitmap.height * scale));
    let best: { blob: Blob; width: number; height: number } | undefined;
    for (const quality of [0.88, 0.82, 0.75]) {
      checkedAbort(signal);
      best = await render(bitmap, width, height, rotation, quality, true);
      if (best.blob.size <= TARGET_IMAGE_BYTES)
        return { ...best, mimeType: "image/jpeg" };
    }
    while (Math.max(width, height) > 1800) {
      checkedAbort(signal);
      const longEdge = Math.max(
        1800,
        Math.round(Math.max(width, height) * 0.85),
      );
      const ratio = longEdge / Math.max(width, height);
      width = Math.max(1, Math.round(width * ratio));
      height = Math.max(1, Math.round(height * ratio));
      best = await render(bitmap, width, height, rotation, 0.75, true);
      if (best.blob.size <= TARGET_IMAGE_BYTES)
        return { ...best, mimeType: "image/jpeg" };
    }
    if (!best || best.blob.size > MAX_IMAGE_BYTES)
      throw Error("图片处理后仍超过 5MB，请裁剪后重试");
    return { ...best, mimeType: "image/jpeg" };
  } finally {
    bitmap.close();
  }
}

export async function prepareMaterialImage(
  file: File,
  rotation: number,
): Promise<Blob> {
  if (file.type === "application/pdf") return file;
  const bitmap = await decode(file);
  try {
    if (bitmap.width * bitmap.height > 40000000)
      throw Error("照片像素过大，请先裁剪后上传");
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    return (await render(bitmap, width, height, rotation, 0.88, false)).blob;
  } finally {
    bitmap.close();
  }
}
