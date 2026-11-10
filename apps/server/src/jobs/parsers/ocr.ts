import { createAliyunOcr } from "./aliyun-ocr.js";
import { z } from "zod";
import type { ModelGateway } from "../../agent/provider.js";
export interface OcrProvider {
  recognize(
    input: { bytes: Buffer; contentType: string },
    signal: AbortSignal,
  ): Promise<{ text: string }>;
}
const resultSchema = z.object({ text: z.string().max(200000) });
export function createOcr(
  env: Record<string, string | undefined>,
  gateway?: ModelGateway,
): OcrProvider | undefined {
  if (env.OCR_PROVIDER === "aliyun") return createAliyunOcr(env);
  if (
    env.OCR_PROVIDER === "http-json-v1" &&
    env.OCR_BASE_URL &&
    env.OCR_API_KEY
  ) {
    const url = env.OCR_BASE_URL;
    if (new URL(url).protocol !== "https:") throw Error("OCR requires HTTPS");
    const key = env.OCR_API_KEY;
    return {
      async recognize(input, signal) {
        const response = await fetch(url, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            imageBase64: input.bytes.toString("base64"),
            mimeType: input.contentType,
          }),
        });
        if (!response.ok) throw Error("OCR_UNAVAILABLE");
        return resultSchema.parse(await response.json());
      },
    };
  }
  if (gateway?.runtime.model.input.includes("image"))
    return {
      async recognize(input, signal) {
        const result = await gateway.complete(
          {
            priority: "background",
            context: {
              systemPrompt:
                "只转录图片中可见的题目、作答与批注，区分其角色，保留公式。无法辨认的内容写[无法辨认]，不得补造。",
              messages: [
                {
                  role: "user",
                  timestamp: Date.now(),
                  content: [
                    { type: "text", text: "转录这页资料。" },
                    {
                      type: "image",
                      data: input.bytes.toString("base64"),
                      mimeType: input.contentType,
                    },
                  ],
                },
              ],
            },
          },
          signal,
        );
        return { text: result.text };
      },
    };
  return undefined;
}
