import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import {
  createBatchInput,
  editItemInput,
  reparseInput,
  searchInput,
} from "../../packages/contracts/src/knowledge-base.js";
import {
  fileTooLarge,
  MAX_MATERIAL_PDF_BYTES,
} from "../../packages/contracts/src/file-limits.js";

it("rejects empty and oversized batch submissions", () => {
  expect(createBatchInput.safeParse({}).success).toBe(false);
  expect(createBatchInput.safeParse({ text: "   " }).success).toBe(false);
  expect(
    createBatchInput.safeParse({ text: "x".repeat(50_001) }).success,
  ).toBe(false);
  expect(
    createBatchInput.safeParse({ text: "x", extra: "nope" }).success,
  ).toBe(false);
  expect(createBatchInput.safeParse({ text: "函数与方程" }).success).toBe(true);
  expect(
    createBatchInput.safeParse({ fileIds: [randomUUID()] }).success,
  ).toBe(true);
});

it("requires non-empty title and summary when editing items", () => {
  expect(editItemInput.safeParse({ title: "", summary: "内容" }).success).toBe(
    false,
  );
  expect(editItemInput.safeParse({ title: "标题", summary: "  " }).success).toBe(
    false,
  );
  expect(
    editItemInput.safeParse({ title: "x".repeat(201), summary: "内容" }).success,
  ).toBe(false);
  expect(
    editItemInput.safeParse({ title: "标题", summary: "x".repeat(20_001) })
      .success,
  ).toBe(false);
  expect(
    editItemInput.safeParse({ title: "标题", summary: "内容" }).success,
  ).toBe(true);
});

it("validates reparse and search inputs", () => {
  expect(reparseInput.safeParse({ extraPrompt: "" }).success).toBe(false);
  expect(reparseInput.safeParse({ extraPrompt: "按步骤拆" }).success).toBe(true);
  expect(
    reparseInput.safeParse({ extraPrompt: "按步骤拆", replacesItemId: "x" })
      .success,
  ).toBe(false);
  expect(reparseInput.safeParse({}).success).toBe(false);
  expect(searchInput.safeParse({ keywords: "分数" }).success).toBe(true);
  expect(searchInput.parse({ keywords: "分数" }).limit).toBe(5);
  expect(searchInput.safeParse({ keywords: "分数", limit: 9 }).success).toBe(
    false,
  );
  expect(searchInput.safeParse({ keywords: "" }).success).toBe(false);
});

it("applies knowledge source size limits", () => {
  expect(
    fileTooLarge("knowledge_source", "application/pdf", MAX_MATERIAL_PDF_BYTES),
  ).toBe(true);
  expect(
    fileTooLarge(
      "knowledge_source",
      "application/pdf",
      MAX_MATERIAL_PDF_BYTES - 1,
    ),
  ).toBe(false);
  expect(fileTooLarge("knowledge_source", "text/plain", 10 * 1024 ** 2)).toBe(
    true,
  );
  expect(fileTooLarge("knowledge_source", "text/plain", 10 * 1024 ** 2 - 1)).toBe(
    false,
  );
});
