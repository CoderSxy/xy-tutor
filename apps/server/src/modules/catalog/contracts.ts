import { z } from "zod";
export const draftInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    edition: z.string().trim().min(1).max(40),
    grade: z.string().trim().min(1).max(40),
    subject: z.string().trim().min(1).max(40),
    term: z.enum(["上册", "下册", "全册"]),
    publicationYear: z.number().int().min(1900).max(2100),
    fileId: z.uuid(),
  })
  .strict();
export const reviewInput = z
  .object({
    revisionId: z.uuid(),
    pageIndex: z.number().int().min(0).max(99),
    text: z.string().max(200000).optional(),
    printedPageLabel: z.string().max(40).optional(),
    chapter: z.string().trim().min(1).max(100).optional(),
    excluded: z.boolean().optional(),
  })
  .strict();
export type RevisionDTO = {
  id: string;
  textbookId: string;
  fileId: string;
  revisionNo: number;
  status: string;
  pageCount: number | null;
  title: string;
  edition: string;
  grade: string;
  subject: string;
  term: string;
  publicationYear: number;
};
export type CatalogFilter = {
  edition?: string;
  grade?: string;
  subject?: string;
};
