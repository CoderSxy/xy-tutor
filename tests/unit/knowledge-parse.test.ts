import { describe, expect, it } from "vitest";
import {
  MAX_KNOWLEDGE_ITEMS,
  MAX_KNOWLEDGE_TEXT,
  extractBatchText,
  parseKnowledgeItemsResponse,
} from "../../apps/server/src/modules/knowledge-base/parser.js";

describe("parseKnowledgeItemsResponse", () => {
  it("parses valid JSON into multiple items and trims fields", () => {
    expect(
      parseKnowledgeItemsResponse(
        JSON.stringify({
          items: [
            { title: " 一元一次方程 ", summary: " 移项与合并同类项 " },
            { title: "分数加减法", summary: "先通分再计算" },
          ],
        }),
      ),
    ).toEqual([
      { title: "一元一次方程", summary: "移项与合并同类项" },
      { title: "分数加减法", summary: "先通分再计算" },
    ]);
  });

  it("accepts JSON wrapped in a markdown code fence", () => {
    expect(
      parseKnowledgeItemsResponse(
        '```json\n{"items":[{"title":"勾股定理","summary":"直角三角形三边关系"}]}\n```',
      ),
    ).toEqual([{ title: "勾股定理", summary: "直角三角形三边关系" }]);
  });

  it("rejects non-JSON and malformed payloads", () => {
    expect(() => parseKnowledgeItemsResponse("这不是 JSON")).toThrow(
      "PARSE_INVALID_OUTPUT",
    );
    expect(() =>
      parseKnowledgeItemsResponse(JSON.stringify({ items: [] })),
    ).toThrow("PARSE_INVALID_OUTPUT");
    expect(() =>
      parseKnowledgeItemsResponse(
        JSON.stringify({ items: [{ summary: "缺标题" }] }),
      ),
    ).toThrow("PARSE_INVALID_OUTPUT");
    expect(() =>
      parseKnowledgeItemsResponse(
        JSON.stringify({ items: [{ title: "   ", summary: "空标题" }] }),
      ),
    ).toThrow("PARSE_INVALID_OUTPUT");
    expect(() =>
      parseKnowledgeItemsResponse(
        JSON.stringify({ items: [{ title: "标题" }] }),
      ),
    ).toThrow("PARSE_INVALID_OUTPUT");
  });

  it("keeps at most the first 30 items", () => {
    const items = Array.from({ length: MAX_KNOWLEDGE_ITEMS + 7 }, (_, i) => ({
      title: `知识点 ${i}`,
      summary: `摘要 ${i}`,
    }));
    const parsed = parseKnowledgeItemsResponse(JSON.stringify({ items }));
    expect(parsed).toHaveLength(MAX_KNOWLEDGE_ITEMS);
    expect(parsed[0]!.title).toBe("知识点 0");
    expect(parsed.at(-1)!.title).toBe(`知识点 ${MAX_KNOWLEDGE_ITEMS - 1}`);
  });
});

describe("extractBatchText", () => {
  const signal = new AbortController().signal;

  it("combines batch text with UTF-8 text files in order", async () => {
    const text = await extractBatchText(
      {
        textContent: "分数加减法",
        files: [
          { content_type: "text/markdown", object_key: "knowledge_source/a" },
          { content_type: "text/plain", object_key: "knowledge_source/b" },
        ],
      },
      {
        read: async (key) =>
          Buffer.from(key.endsWith("a") ? "# 通分\n先找公分母" : "约分"),
        signal,
      },
    );
    expect(text).toBe("分数加减法\n\n# 通分\n先找公分母\n\n约分");
  });

  it("truncates combined text at 80,000 characters", async () => {
    const text = await extractBatchText(
      {
        textContent: "甲".repeat(MAX_KNOWLEDGE_TEXT + 50_000),
        files: [{ content_type: "text/plain", object_key: "knowledge_source/a" }],
      },
      { read: async () => Buffer.from("乙乙乙"), signal },
    );
    expect(text).toHaveLength(MAX_KNOWLEDGE_TEXT);
  });
});
