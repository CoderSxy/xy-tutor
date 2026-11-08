import { z } from "zod";
export const sourceSchema = z
  .object({
    pageIndex: z.number().int().min(0).max(99),
    bbox: z
      .tuple([z.number(), z.number(), z.number(), z.number()])
      .refine(
        (b) => b.every((n) => n >= 0 && n <= 1) && b[0] < b[2] && b[1] < b[3],
        "Invalid source region",
      ),
  })
  .strict();
export const candidateSchema = z
  .object({
    candidateId: z.string().min(1).max(100),
    stem: z.string().max(20000),
    studentAnswer: z.string().max(20000).optional(),
    teacherAnnotation: z.string().max(2000).optional(),
    sources: z.array(sourceSchema).min(1).max(10),
  })
  .strict();
export const extractionSchema = z
  .object({
    pages: z
      .array(
        z.object({
          pdfPageIndex: z.number().int().min(0).max(99),
          text: z.string().max(200000),
          status: z.enum(["ready", "needs_ocr", "failed"]),
        }),
      )
      .min(1)
      .max(100),
    questions: z.array(candidateSchema).max(100),
  })
  .strict();
export type ExtractionInput = z.infer<typeof extractionSchema>;
export const confirmationSchema = z
  .object({
    materialId: z.uuid(),
    extractionVersion: z.number().int().positive(),
    questions: z
      .array(
        z
          .object({
            candidateIds: z.array(z.string()).min(1).max(20),
            stem: z.string().trim().min(1).max(20000),
            studentAnswer: z.string().max(20000).optional(),
            teacherAnnotation: z.string().max(2000).optional(),
            sources: z.array(sourceSchema).min(1).max(10),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
