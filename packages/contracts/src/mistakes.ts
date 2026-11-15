import { z } from "zod";

export const mistakeOriginCategorySchema = z.enum([
  "uploaded",
  "learning",
  "unknown",
]);
export type MistakeOriginCategory = z.infer<typeof mistakeOriginCategorySchema>;

export const mistakeOriginDetailSchema = z.enum([
  "material_import",
  "daily_practice",
  "knowledge_consolidation",
  "free_question",
  "mistake_review",
  "unknown",
]);
export type MistakeOriginDetail = z.infer<typeof mistakeOriginDetailSchema>;

export const mistakeLifecycleSchema = z.enum(["active", "revoked"]);
export type MistakeLifecycle = z.infer<typeof mistakeLifecycleSchema>;

export const mistakeStateSchema = z.enum([
  "pending_correction",
  "correcting",
  "corrected_pending_practice",
  "consolidated_pending_review",
  "mastered",
]);
export type MistakeStateName = z.infer<typeof mistakeStateSchema>;

export const mistakeSchema = z
  .object({
    id: z.uuid(),
    questionId: z.uuid(),
    questionVersionId: z.uuid(),
    stem: z.string(),
    status: mistakeStateSchema,
    dueAt: z.iso.datetime().nullable(),
    version: z.number().int().positive(),
    originalAttemptId: z.uuid().nullable(),
    hasImageEvidence: z.boolean(),
    originCategory: mistakeOriginCategorySchema,
    originDetail: mistakeOriginDetailSchema,
    lifecycle: mistakeLifecycleSchema,
    originTaskId: z.uuid().nullable(),
    originConversationId: z.uuid().nullable(),
    originMessageVersionId: z.uuid().nullable(),
    originQuestionVersionId: z.uuid().nullable(),
  })
  .strict();
export type MistakeDTO = z.infer<typeof mistakeSchema>;

export const mistakeOriginCountsSchema = z
  .object({
    all: z.number().int().nonnegative(),
    uploaded: z.number().int().nonnegative(),
    learning: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  })
  .strict();
export type MistakeOriginCounts = z.infer<typeof mistakeOriginCountsSchema>;

export const mistakePageSchema = z
  .object({
    items: z.array(mistakeSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().min(1).max(50),
    originCounts: mistakeOriginCountsSchema,
  })
  .strict();
export type MistakePage = z.infer<typeof mistakePageSchema>;

export const mistakeListQuerySchema = z
  .object({
    origin: mistakeOriginCategorySchema.optional(),
    status: mistakeStateSchema.optional(),
    includeArchived: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => v === "true"),
    questionId: z.uuid().optional(),
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().min(1).max(50).optional(),
  })
  .passthrough();
export type MistakeListQuery = z.infer<typeof mistakeListQuerySchema>;

/** Client input; provenance is always derived and validated server-side. */
export const mistakeAddInputSchema = z
  .object({
    questionVersionId: z.uuid(),
    attemptId: z.uuid().optional(),
  })
  .strict();
