import { z } from "zod";

export const questionTypeSchema = z.enum([
  "single_choice",
  "multiple_choice",
  "fill_blank",
  "worked",
  "legacy",
]);
export type QuestionType = z.infer<typeof questionTypeSchema>;

export const languageStatusSchema = z.enum([
  "unchecked",
  "accepted",
  "repair_required",
]);
export type LanguageStatus = z.infer<typeof languageStatusSchema>;

export const LANGUAGE_POLICY_VERSION = "zh-student-v1" as const;

export const choiceOptionSchema = z
  .object({
    optionId: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(500),
  })
  .strict();
export type ChoiceOption = z.infer<typeof choiceOptionSchema>;

export const choicePresentationSchema = z
  .object({
    kind: z.literal("choice"),
    multiple: z.boolean(),
    options: z.array(choiceOptionSchema).min(2).max(6),
  })
  .strict()
  .refine(
    (v) => new Set(v.options.map((o) => o.optionId)).size === v.options.length,
    { message: "选项 ID 必须唯一" },
  );

export const blankPresentationSchema = z
  .object({
    kind: z.literal("blank"),
    blanks: z
      .array(
        z
          .object({
            blankId: z.string().trim().min(1).max(64),
            label: z.string().trim().max(120).optional(),
            placeholder: z.string().trim().max(200).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict()
  .refine(
    (v) => new Set(v.blanks.map((b) => b.blankId)).size === v.blanks.length,
    { message: "空位 ID 必须唯一" },
  );

export const workedPresentationSchema = z
  .object({
    kind: z.literal("worked"),
    requirements: z.string().trim().min(1).max(2000),
    requiresWorking: z.boolean(),
  })
  .strict();

export const questionPresentationSchema = z.discriminatedUnion("kind", [
  choicePresentationSchema,
  blankPresentationSchema,
  workedPresentationSchema,
]);
export type QuestionPresentation = z.infer<typeof questionPresentationSchema>;

export const blankValidationSchema = z.enum(["number", "expression", "text"]);
export type BlankValidation = z.infer<typeof blankValidationSchema>;

export const blankSpecSchema = z
  .object({
    blankId: z.string().trim().min(1).max(64),
    validation: blankValidationSchema,
    answer: z.string().max(2000),
    equivalents: z.array(z.string().max(2000)).max(20).optional(),
  })
  .strict();

/**
 * Private server-only answer specification. Never serialize this into a
 * student-facing question DTO.
 */
export const answerSpecSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("single_choice"),
      correctOptionId: z.string().trim().min(1).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal("multiple_choice"),
      correctOptionIds: z.array(z.string().trim().min(1).max(64)).min(1).max(6),
    })
    .strict()
    .refine(
      (v) => new Set(v.correctOptionIds).size === v.correctOptionIds.length,
      { message: "正确选项不能重复" },
    ),
  z
    .object({
      kind: z.literal("fill_blank"),
      blanks: z.array(blankSpecSchema).min(1).max(6),
    })
    .strict(),
  z
    .object({
      kind: z.literal("worked"),
      requiresWorking: z.boolean(),
      rubric: z.array(z.string().trim().min(1).max(1000)).max(20),
      referenceAnswer: z.string().max(10000),
      verificationStrategy: z.enum(["deterministic", "model", "manual"]),
    })
    .strict(),
]);
export type AnswerSpec = z.infer<typeof answerSpecSchema>;

export const answerPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("choice"),
      optionIds: z.array(z.string().trim().min(1).max(64)).min(1).max(6),
    })
    .strict(),
  z
    .object({
      kind: z.literal("blanks"),
      values: z
        .array(
          z
            .object({
              blankId: z.string().trim().min(1).max(64),
              value: z.string().max(2000),
            })
            .strict(),
        )
        .min(1)
        .max(6),
    })
    .strict(),
  z
    .object({
      kind: z.literal("worked"),
      text: z.string().trim().max(20000),
      attachmentIds: z.array(z.uuid()).max(9),
    })
    .strict(),
]);
export type AnswerPayload = z.infer<typeof answerPayloadSchema>;

/**
 * Student-facing projection. Strict: answerSpec, rubric and referenceAnswer
 * are not permitted here.
 */
export const publicQuestionSchema = z
  .object({
    questionVersionId: z.uuid(),
    stem: z.string(),
    questionType: questionTypeSchema,
    knowledgePoint: z.string().nullable(),
    presentation: questionPresentationSchema.nullable(),
  })
  .strict();
export type PublicQuestion = z.infer<typeof publicQuestionSchema>;

export const presentationCandidateSchema = z
  .object({
    questionType: questionTypeSchema,
    stem: z.string().trim().min(1).max(20000),
    presentation: questionPresentationSchema.nullable(),
    answerSpec: answerSpecSchema.nullable(),
    referenceAnswer: z.string().max(10000).nullable(),
    rubric: z.array(z.string()).max(20),
  })
  .strict();
export type PresentationCandidate = z.infer<typeof presentationCandidateSchema>;
