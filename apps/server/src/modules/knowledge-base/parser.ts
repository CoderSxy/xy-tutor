import type { ModelGateway } from "../../agent/provider.js";
import { parseDocument } from "../../jobs/parsers/pdf-process.js";
import type { OcrProvider } from "../../jobs/parsers/ocr.js";

export const MAX_KNOWLEDGE_ITEMS = 30;
export const MAX_KNOWLEDGE_TEXT = 80_000;

export type KnowledgeProposal = { title: string; summary: string };

export type KnowledgeBatchSource = {
  textContent: string | null;
  files: { content_type: string; object_key: string }[];
};

export type KnowledgeTextReader = {
  read(key: string): Promise<Buffer>;
  ocr?: OcrProvider;
  signal: AbortSignal;
};

export function parseKnowledgeItemsResponse(text: string): KnowledgeProposal[] {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw Error("PARSE_INVALID_OUTPUT");
  }
  const items = (value as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length === 0)
    throw Error("PARSE_INVALID_OUTPUT");
  const parsed: KnowledgeProposal[] = [];
  for (const item of items.slice(0, MAX_KNOWLEDGE_ITEMS)) {
    const title =
      typeof (item as { title?: unknown })?.title === "string"
        ? (item as { title: string }).title.trim()
        : "";
    const summary =
      typeof (item as { summary?: unknown })?.summary === "string"
        ? (item as { summary: string }).summary.trim()
        : "";
    if (!title || title.length > 200 || !summary || summary.length > 20_000)
      throw Error("PARSE_INVALID_OUTPUT");
    parsed.push({ title, summary });
  }
  return parsed;
}

export async function proposeKnowledgeItems(
  gateway: ModelGateway,
  text: string,
  extraPrompt: string | null,
  signal: AbortSignal,
): Promise<KnowledgeProposal[]> {
  const response = await gateway.complete(
    {
      priority: "background",
      context: {
        systemPrompt:
          '你是知识点整理助手。只依据给定材料拆分知识点，使用中文，只输出 JSON 对象 {"items":[{"title":"...","summary":"..."}]}，不要编造材料中不存在的内容，不要输出 JSON 以外的文字。',
        messages: [
          {
            role: "user",
            content: JSON.stringify({ text, extraPrompt: extraPrompt ?? null }),
            timestamp: Date.now(),
          },
        ],
      },
    },
    signal,
  );
  return parseKnowledgeItemsResponse(response.text);
}

export async function extractBatchText(
  batch: KnowledgeBatchSource,
  reader: KnowledgeTextReader,
): Promise<string> {
  const parts: string[] = [];
  const push = (part: string) => {
    const trimmed = part.trim();
    if (trimmed) parts.push(trimmed);
  };
  if (batch.textContent) push(batch.textContent);
  for (const file of batch.files) {
    if (file.content_type === "text/plain" || file.content_type === "text/markdown") {
      push((await reader.read(file.object_key)).toString("utf8"));
      continue;
    }
    if (
      file.content_type === "application/pdf" ||
      file.content_type.startsWith("image/")
    ) {
      const pages: string[] = [];
      for await (const page of parseDocument({
        read: () => reader.read(file.object_key),
        contentType: file.content_type,
        signal: reader.signal,
        ocr: reader.ocr,
      })) {
        if (page.status === "needs_ocr") throw Error("OCR_UNAVAILABLE");
        if (page.status === "ready" && page.text) pages.push(page.text);
      }
      push(pages.join("\n"));
      continue;
    }
    throw Error("INVALID_KNOWLEDGE_SOURCE");
  }
  return parts.join("\n\n").slice(0, MAX_KNOWLEDGE_TEXT);
}
