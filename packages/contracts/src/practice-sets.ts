import { z } from "zod";
import { timingEventSchema } from "./learning-timing.js";
import {
  answerPayloadSchema,
  questionPresentationSchema,
  questionTypeSchema,
} from "./question-presentation.js";

export const practiceModeSchema = z.enum(["step", "batch"]);
export type PracticeMode = z.infer<typeof practiceModeSchema>;

export const practiceStrategySchema = z.enum(["mixed", "exam"]);
export type PracticeStrategy = z.infer<typeof practiceStrategySchema>;

export const practiceGenerationSchema = z.enum([
  "awaiting_scope",
  "preparing",
  "ready",
  "insufficient_pool",
  "failed",
]);
export type PracticeGeneration = z.infer<typeof practiceGenerationSchema>;

export const practiceSubmissionStateSchema = z.enum([
  "open",
  "grading",
  "needs_review",
  "completed",
]);
export type PracticeSubmissionState = z.infer<
  typeof practiceSubmissionStateSchema
>;

export const submissionStateSchema = z.enum([
  "grading",
  "needs_review",
  "completed",
]);
export type SubmissionState = z.infer<typeof submissionStateSchema>;

export const practiceItemSubmissionSchema = z.enum([
  "unanswered",
  "submitted",
  "skipped",
]);
export const practiceGradingSchema = z.enum([
  "none",
  "queued",
  "running",
  "verified",
  "pending",
  "failed",
]);
export const practiceCorrectnessSchema = z.enum([
  "correct",
  "incorrect",
  "uncertain",
]);
export const practiceMistakeSyncSchema = z.enum([
  "not_required",
  "queued",
  "synced",
  "failed",
]);

export const practiceItemProgressSchema = z
  .object({
    itemId: z.uuid(),
    submission: practiceItemSubmissionSchema,
    grading: practiceGradingSchema,
    correctness: practiceCorrectnessSchema.nullable(),
    mistakeSync: practiceMistakeSyncSchema,
  })
  .strict();
export type PracticeItemProgress = z.infer<typeof practiceItemProgressSchema>;

export const practiceCountsSchema = z
  .object({
    total: z.literal(5),
    submitted: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  })
  .strict();
export type PracticeCounts = z.infer<typeof practiceCountsSchema>;

export const practiceItemSchema = z
  .object({
    slotId: z.uuid(),
    position: z.number().int().min(0).max(4),
    questionType: questionTypeSchema,
    itemId: z.uuid().nullable(),
    questionVersionId: z.uuid().nullable(),
    stem: z.string().nullable(),
    presentation: questionPresentationSchema.nullable(),
    progress: practiceItemProgressSchema,
    reasonCode: z.string().nullable(),
  })
  .strict();
export type PracticeItemDTO = z.infer<typeof practiceItemSchema>;

export const practiceSetSchema = z
  .object({
    id: z.uuid(),
    taskId: z.uuid(),
    version: z.number().int().positive(),
    mode: practiceModeSchema,
    strategy: practiceStrategySchema,
    examProfileId: z.string().nullable(),
    generation: practiceGenerationSchema,
    submission: practiceSubmissionStateSchema,
    counts: practiceCountsSchema,
    canContinue: z.boolean(),
    items: z.array(practiceItemSchema).max(5),
  })
  .strict();
export type PracticeSetDTO = z.infer<typeof practiceSetSchema>;

export const submitEntrySchema = z
  .object({
    itemId: z.uuid(),
    answer: answerPayloadSchema,
    episodeId: z.uuid().optional(),
    timingFinalEvent: timingEventSchema.optional(),
  })
  .strict();

export const submitPracticeInputSchema = z
  .object({
    requestKey: z.string().trim().min(1).max(120),
    expectedVersion: z.number().int().positive(),
    entries: z.array(submitEntrySchema).max(5),
    skippedItemIds: z.array(z.uuid()).max(5),
    finalize: z.boolean(),
  })
  .strict();
export type SubmitPracticeInput = z.infer<typeof submitPracticeInputSchema>;

export const submissionSchema = z
  .object({
    id: z.uuid(),
    setId: z.uuid(),
    state: submissionStateSchema,
    items: z.array(practiceItemProgressSchema),
  })
  .strict();
export type SubmissionDTO = z.infer<typeof submissionSchema>;

export const draftInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    answer: answerPayloadSchema,
  })
  .strict();
export type DraftInput = z.infer<typeof draftInputSchema>;

export const draftSchema = z
  .object({
    itemId: z.uuid(),
    answer: answerPayloadSchema,
    version: z.number().int().positive(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type DraftDTO = z.infer<typeof draftSchema>;

export const preferencesSchema = z
  .object({
    version: z.number().int().positive(),
    mode: practiceModeSchema.nullable(),
    strategy: practiceStrategySchema,
    examProfileId: z.string().nullable(),
  })
  .strict();
export type PreferencesDTO = z.infer<typeof preferencesSchema>;

export const preferencesPatchSchema = z
  .object({
    expectedVersion: z.number().int().positive().optional(),
    mode: practiceModeSchema.nullable().optional(),
    strategy: practiceStrategySchema.optional(),
    examProfileId: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .strict();
export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;

export const continueInputSchema = z
  .object({
    requestKey: z.string().trim().min(1).max(120),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type ContinueInput = z.infer<typeof continueInputSchema>;

export type ContinueResult = {
  taskId: string;
  setId: string;
  conversationId: string;
};

export const practiceSetCreateInputSchema = z
  .object({
    requestKey: z.string().trim().min(1).max(120),
    mode: practiceModeSchema,
    strategy: practiceStrategySchema.default("mixed"),
    examProfileId: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .strict();
export type PracticeSetCreateInput = z.infer<
  typeof practiceSetCreateInputSchema
>;

export const retryGenerationInputSchema = z
  .object({
    requestKey: z.string().trim().min(1).max(120),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type RetryGenerationInput = z.infer<typeof retryGenerationInputSchema>;

export const retrySubmissionInputSchema = z
  .object({
    requestKey: z.string().trim().min(1).max(120),
    itemIds: z.array(z.uuid()).min(1).max(5),
  })
  .strict();
export type RetrySubmissionInput = z.infer<typeof retrySubmissionInputSchema>;

export const changeModeInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    mode: practiceModeSchema,
  })
  .strict();
export type ChangeModeInput = z.infer<typeof changeModeInputSchema>;

export const examProfileSchema = z
  .object({
    profileId: z.string().trim().min(1).max(120),
    version: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(200),
    scopeDescription: z.string().trim().min(1).max(1000),
    sourceNote: z.string().trim().min(1).max(1000),
    weights: z.record(questionTypeSchema, z.number().nonnegative()),
    supportedTypes: z.array(questionTypeSchema).min(1),
  })
  .strict();
export type ExamProfile = z.infer<typeof examProfileSchema>;
