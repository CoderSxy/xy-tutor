import type { ModelGateway } from "../../agent/provider.js";
import { parseDocument } from "../../jobs/parsers/pdf-process.js";
import type { OcrProvider } from "../../jobs/parsers/ocr.js";

export const MAX_KNOWLEDGE_ITEMS = 30;
export const MAX_KNOWLEDGE_TEXT = 80_000;

export type KnowledgeProposal = {
  title: string;
  summary: string;
  sourceTitle?: string;
};

export type KnowledgeBatchSource = {
  textContent: string | null;
  files: { content_type: string; object_key: string }[];
};

export type KnowledgeTextReader = {
  read(key: string): Promise<Buffer>;
  ocr?: OcrProvider;
  signal: AbortSignal;
};

export function readKnowledgeItems(text: string): {
  items: KnowledgeProposal[];
  omittedItemCount: number;
} {
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
    const source = (item as { sourceTitle?: unknown }).sourceTitle;
    const sourceTitle = typeof source === "string" ? source.trim() : "";
    parsed.push(
      sourceTitle && sourceTitle.length <= 200
        ? { title, summary, sourceTitle }
        : { title, summary },
    );
  }
  return {
    items: parsed,
    omittedItemCount: Math.max(0, items.length - MAX_KNOWLEDGE_ITEMS),
  };
}

export function parseKnowledgeItemsResponse(text: string): KnowledgeProposal[] {
  return readKnowledgeItems(text).items;
}

export async function proposeKnowledgeItems(
  gateway: ModelGateway,
  text: string,
  extraPrompt: string | null,
  signal: AbortSignal,
  options: {
    focus?: { title: string; summary: string };
    publishedItems?: { title: string; summary: string }[];
  } = {},
): Promise<{ items: KnowledgeProposal[]; omittedItemCount: number }> {
  const publishedItems = options.publishedItems ?? [];
  const revisingList = publishedItems.length > 0;
  const response = await gateway.complete(
    {
      priority: "background",
      context: {
        systemPrompt: revisingList
          ? '你是知识点整理助手。只依据给定材料整理知识点，使用中文，只输出 JSON 对象 {"items":[{"title":"...","summary":"...","sourceTitle":"原标题或省略"}]}。修订已有条目时 sourceTitle 必须等于该条原标题，title 可以修改；全新知识点不要带 sourceTitle。不要编造材料中不存在的内容，不要输出 JSON 以外的文字。'
          : '你是知识点整理助手。只依据给定材料拆分知识点，使用中文，只输出 JSON 对象 {"items":[{"title":"...","summary":"..."}]}，不要编造材料中不存在的内容，不要输出 JSON 以外的文字。',
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              ...(options.focus ? { focus: options.focus } : {}),
              text,
              extraPrompt: extraPrompt ?? null,
              ...(options.focus
                ? {
                    note: "只修订 focus 这一条。text 是同一批原始资料，只能用来补充这一条的细节，不要输出资料里的其他知识点。可以拆成多条，但每条都必须是这一条的细化。",
                  }
                : {}),
              ...(revisingList
                ? {
                    publishedItems,
                    note: "修订上面某条已发布知识点时，必须带 sourceTitle 且等于它的原标题，title 可以改。没有 sourceTitle 的条目会作为全新知识点，已发布内容会保留。",
                  }
                : {}),
            }),
            timestamp: Date.now(),
          },
        ],
      },
    },
    signal,
  );
  return readKnowledgeItems(response.text);
}

export async function extractBatchText(
  batch: KnowledgeBatchSource,
  reader: KnowledgeTextReader,
): Promise<{ text: string; truncated: boolean }> {
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
  const combined = parts.join("\n\n");
  return {
    text: combined.slice(0, MAX_KNOWLEDGE_TEXT),
    truncated: combined.length > MAX_KNOWLEDGE_TEXT,
  };
}
