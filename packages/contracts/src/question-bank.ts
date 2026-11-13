import { z } from "zod";

export type PracticeGoal = "diagnostic" | "repair" | "transfer" | "review";
export type DifficultyBand = "easy" | "medium" | "challenge";

export const practiceGoalSchema = z.enum([
  "diagnostic",
  "repair",
  "transfer",
  "review",
]);
export const difficultyBandSchema = z.enum(["easy", "medium", "challenge"]);
export const visibilitySchema = z.enum(["shared", "owner_only"]);
export const questionEntryStatusSchema = z.enum([
  "draft",
  "checking",
  "pending_review",
  "published",
  "rejected",
  "withdrawn",
]);
export const questionSourceTypeSchema = z.enum([
  "private_upload",
  "shared_upload",
  "template",
  "generated",
]);

export const skillCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "技能代码应使用小写字母、数字和下划线");

export const skillCreateInputSchema = z
  .object({
    code: skillCodeSchema,
    name: z.string().trim().min(1).max(120),
  })
  .strict();

export type SkillCreateInput = z.infer<typeof skillCreateInputSchema>;

export const skillPrerequisitesInputSchema = z
  .object({
    prerequisiteIds: z.array(z.uuid()).max(20),
  })
  .strict();

export type SkillPrerequisitesInput = z.infer<
  typeof skillPrerequisitesInputSchema
>;

export const questionEntryInputSchema = z
  .object({
    questionVersionId: z.uuid(),
    skillId: z.uuid(),
    difficultyBand: difficultyBandSchema,
    complexityBand: z.number().int().min(1).max(3),
    visibility: visibilitySchema.default("owner_only"),
    sourceType: questionSourceTypeSchema,
    sourceRef: z.string().trim().max(200).optional(),
    templateFamily: z.string().trim().max(64).optional(),
    knowledgeItemId: z.uuid().optional(),
  })
  .strict();

export type QuestionEntryInput = z.infer<typeof questionEntryInputSchema>;

export type SkillDTO = {
  id: string;
  code: string;
  name: string;
  status: "active" | "withdrawn";
  prerequisiteIds: string[];
};

export type QuestionEntryDTO = {
  id: string;
  questionVersionId: string;
  skillId: string;
  difficultyBand: DifficultyBand;
  complexityBand: number;
  visibility: "shared" | "owner_only";
  ownerId: string | null;
  status: (typeof questionEntryStatusSchema.options)[number];
  version: number;
  publishedAt: string | null;
};

export const questionEntryWithdrawInputSchema = z
  .object({
    reason: z.string().trim().min(1).max(300),
  })
  .strict();

export const bankSearchQuerySchema = z
  .object({
    skillId: z.uuid(),
    goal: practiceGoalSchema,
    difficulty: difficultyBandSchema.optional(),
    answerType: z.string().trim().max(32).optional(),
    excludeVersionIds: z.array(z.uuid()).max(50).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

export type BankSearchQuery = z.infer<typeof bankSearchQuerySchema>;
export type BankSearchQueryInput = z.input<typeof bankSearchQuerySchema>;

export const bankCandidateSchema = z
  .object({
    entryId: z.uuid(),
    questionVersionId: z.uuid(),
    skillId: z.uuid(),
    difficulty: difficultyBandSchema,
    complexityBand: z.number().int().min(1).max(3),
    answerType: z.string(),
    templateFamily: z.string().nullable(),
    matchedCauseCount: z.number().int().nonnegative(),
    seenCount: z.number().int().nonnegative(),
  })
  .strict();

export type BankCandidate = z.infer<typeof bankCandidateSchema>;
