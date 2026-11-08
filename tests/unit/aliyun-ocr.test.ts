import { it, expect, vi } from "vitest";
import { createOcr } from "../../apps/server/src/jobs/parsers/ocr.js";
import { AliyunOcrProvider } from "../../apps/server/src/jobs/parsers/aliyun-ocr.js";
const keys = {
  OCR_PROVIDER: "aliyun",
  OSS_ACCESS_KEY_ID: "test-id",
  OSS_ACCESS_KEY_SECRET: "test-secret",
};
it("selects Aliyun OCR with the existing authorized OSS credential pair", () => {
  expect(createOcr(keys)).toBeInstanceOf(AliyunOcrProvider);
  expect(createOcr({ OCR_PROVIDER: "aliyun" })).toBeUndefined();
  expect(() =>
    createOcr({ ...keys, OCR_ACCESS_KEY_ID: "different-id" }),
  ).toThrow("OCR_CREDENTIALS_INCOMPLETE");
});
it("sends binary bytes through the official unified API and maps only recognized text", async () => {
  let body = Buffer.alloc(0);
  const call = vi.fn(
    async (
      request: { body?: AsyncIterable<Buffer>; type?: string },
      runtime: { autoretry?: boolean },
    ) => {
      for await (const chunk of request.body!)
        body = Buffer.concat([body, chunk]);
      expect(request.type).toBe("Advanced");
      expect(runtime.autoretry).toBe(false);
      return { body: { data: { content: "题目：1+1=?\n学生作答：2" } } };
    },
  );
  const p = new AliyunOcrProvider(
    { accessKeyId: "test-id", accessKeySecret: "test-secret" },
    { recognizeAllTextWithOptions: call },
  );
  expect(
    await p.recognize(
      { bytes: Buffer.from("image-binary"), contentType: "image/png" },
      new AbortController().signal,
    ),
  ).toEqual({ text: "题目：1+1=?\n学生作答：2" });
  expect(body.toString()).toBe("image-binary");
  expect(call).toHaveBeenCalledOnce();
});
it("rejects oversized input and pre-cancelled requests without calling the supplier", async () => {
  const call = vi.fn();
  const p = new AliyunOcrProvider(
    { accessKeyId: "test-id", accessKeySecret: "test-secret" },
    { recognizeAllTextWithOptions: call },
  );
  await expect(
    p.recognize(
      { bytes: Buffer.alloc(10 * 1024 ** 2 + 1), contentType: "image/png" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("OCR_IMAGE_LIMIT");
  await expect(
    p.recognize(
      { bytes: Buffer.from("x"), contentType: "image/png" },
      AbortSignal.abort(),
    ),
  ).rejects.toThrow();
  expect(call).not.toHaveBeenCalled();
});
it("does not leak supplier errors or accept malformed success data", async () => {
  const call = vi
    .fn()
    .mockRejectedValueOnce(Error("test-secret raw request"))
    .mockResolvedValueOnce({ body: { data: { content: 123 } } });
  const p = new AliyunOcrProvider(
    { accessKeyId: "test-id", accessKeySecret: "test-secret" },
    { recognizeAllTextWithOptions: call },
  );
  for (let n = 0; n < 2; n++)
    await expect(
      p.recognize(
        { bytes: Buffer.from("x"), contentType: "image/png" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/^OCR_UNAVAILABLE$/);
});
it("discards a result received after cancellation while keeping the call bounded", async () => {
  const c = new AbortController();
  let finish!: (value: unknown) => void;
  const call = vi.fn(() => new Promise((resolve) => (finish = resolve)));
  const p = new AliyunOcrProvider(
    { accessKeyId: "test-id", accessKeySecret: "test-secret" },
    { recognizeAllTextWithOptions: call },
  );
  const result = p.recognize(
    { bytes: Buffer.from("x"), contentType: "image/png" },
    c.signal,
  );
  c.abort();
  finish({ body: { data: { content: "已取消的结果" } } });
  await expect(result).rejects.toThrow();
});
