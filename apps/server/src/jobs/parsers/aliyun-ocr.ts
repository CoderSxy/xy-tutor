import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { z } from "zod";
import type { OcrProvider } from "./ocr.js";
// These official SDK packages expose CommonJS defaults; require avoids ESM interop ambiguity.
const require = createRequire(import.meta.url);
const { default: Client, RecognizeAllTextRequest } =
  require("@alicloud/ocr-api20210707") as typeof import("@alicloud/ocr-api20210707");
const { $OpenApiUtil } =
  require("@alicloud/openapi-core") as typeof import("@alicloud/openapi-core");
const { RuntimeOptions } =
  require("@darabonba/typescript") as typeof import("@darabonba/typescript");
type Credentials = { accessKeyId: string; accessKeySecret: string };
type ClientPort = {
  recognizeAllTextWithOptions(
    request: InstanceType<typeof RecognizeAllTextRequest>,
    runtime: InstanceType<typeof RuntimeOptions>,
  ): Promise<unknown>;
};
const response = z.object({
  body: z.object({ data: z.object({ content: z.string().max(200000) }) }),
});
export class AliyunOcrProvider implements OcrProvider {
  private client: ClientPort;
  constructor(credentials: Credentials, client?: ClientPort) {
    this.client =
      client ??
      new Client(
        new $OpenApiUtil.Config({
          ...credentials,
          endpoint: "ocr-api.cn-hangzhou.aliyuncs.com",
          regionId: "cn-hangzhou",
          protocol: "https",
        }),
      );
  }
  async recognize(
    input: { bytes: Buffer; contentType: string },
    signal: AbortSignal,
  ): Promise<{ text: string }> {
    signal.throwIfAborted();
    if (
      input.bytes.length === 0 ||
      input.bytes.length > 10 * 1024 ** 2 ||
      !["image/png", "image/jpeg", "image/webp"].includes(input.contentType)
    )
      throw Error("OCR_IMAGE_LIMIT");
    const body = Readable.from([input.bytes]);
    const abort = () => body.destroy();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await this.client.recognizeAllTextWithOptions(
        new RecognizeAllTextRequest({ body, type: "Advanced" }),
        new RuntimeOptions({
          autoretry: false,
          maxAttempts: 1,
          connectTimeout: 5000,
          readTimeout: 20000,
        }),
      );
      signal.throwIfAborted();
      return { text: response.parse(result).body.data.content };
    } catch {
      signal.throwIfAborted();
      throw Error("OCR_UNAVAILABLE");
    } finally {
      signal.removeEventListener("abort", abort);
      body.destroy();
    }
  }
}
export function createAliyunOcr(
  env: Record<string, string | undefined>,
): AliyunOcrProvider | undefined {
  const ownId = env.OCR_ACCESS_KEY_ID,
    ownSecret = env.OCR_ACCESS_KEY_SECRET;
  if (Boolean(ownId) !== Boolean(ownSecret))
    throw Error("OCR_CREDENTIALS_INCOMPLETE");
  const accessKeyId = ownId || env.OSS_ACCESS_KEY_ID,
    accessKeySecret = ownSecret || env.OSS_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) return undefined;
  return new AliyunOcrProvider({ accessKeyId, accessKeySecret });
}
