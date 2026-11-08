import { it, expect } from "vitest";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { AliyunOcrProvider } from "../../apps/server/src/jobs/parsers/aliyun-ocr.js";
const require = createRequire(import.meta.url);
const { default: Client } =
  require("@alicloud/ocr-api20210707") as typeof import("@alicloud/ocr-api20210707");
const { $OpenApiUtil } =
  require("@alicloud/openapi-core") as typeof import("@alicloud/openapi-core");
it("uses the official SDK binary wire format and maps its real response model", async () => {
  let url = "",
    action = "",
    authorization = "";
  let binary = Buffer.alloc(0);
  const server = createServer(async (req, res) => {
    url = req.url ?? "";
    action = String(req.headers["x-acs-action"]);
    authorization = String(req.headers.authorization);
    for await (const chunk of req) binary = Buffer.concat([binary, chunk]);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        RequestId: "synthetic-local-request",
        Data: { Content: "合成教材文字 1+1=2" },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("NO_TEST_ADDRESS");
    const client = new Client(
      new $OpenApiUtil.Config({
        accessKeyId: "test-id",
        accessKeySecret: "test-secret",
        endpoint: `127.0.0.1:${address.port}`,
        protocol: "http",
        regionId: "cn-hangzhou",
      }),
    );
    const p = new AliyunOcrProvider(
      { accessKeyId: "test-id", accessKeySecret: "test-secret" },
      client,
    );
    expect(
      await p.recognize(
        {
          bytes: Buffer.from("synthetic-image-binary"),
          contentType: "image/png",
        },
        new AbortController().signal,
      ),
    ).toEqual({ text: "合成教材文字 1+1=2" });
    expect(new URL(url, "http://test.invalid").searchParams.get("Type")).toBe(
      "Advanced",
    );
    expect(action).toBe("RecognizeAllText");
    expect(binary.toString()).toBe("synthetic-image-binary");
    expect(authorization).toContain("Credential=test-id");
    expect(authorization).not.toContain("test-secret");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
