import { z } from "zod";
import { evidenceRefSchema } from "./evidence.js";
import { difficultyBandSchema, practiceGoalSchema } from "./question-bank.js";

export type TrainingBand = "repair" | "consolidation" | "advance";
export const trainingBandSchema = z.enum(["repair", "consolidation", "advance"]);

export const efficiencyObservationSchema = z
  .object({
    status: z.enum(["insufficient_samples", "ineligible", "observed"]),
    baselineId: z.uuid().nullable(),
    sampleCount: z.number().int().nonnegative(),
    medianMs: z.number().int().nonnegative().nullable(),
    timeRatio: z.number().nonnegative().nullable(),
    direction: z.enum(["faster", "comparable", "slower"]).nullable(),
    reasonCodes: z.array(z.string()),
  })
  .strict();

export type EfficiencyObservation = z.infer<
  typeof efficiencyObservationSchema
>;

export const profileSchema = z
  .object({
    studentId: z.uuid(),
    skillId: z.uuid(),
    version: z.number().int().positive(),
    stale: z.boolean(),
    trainingBand: trainingBandSchema,
    recentIndependentCorrect: z.number().int().nonnegative(),
    recentDeterminateCount: z.number().int().nonnegative(),
    efficiency: efficiencyObservationSchema,
    evidence: z.array(evidenceRefSchema),
  })
  .strict();

export type ProfileDTO = z.infer<typeof profileSchema>;

export const selectionRequestSchema = z
  .object({
    requestKey: z.string().trim().min(1).max(120),
    expectedProfileVersion: z.number().int().positive(),
  })
  .strict();

export type SelectionRequest = z.infer<typeof selectionRequestSchema>;

export const practiceDecisionSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(["selected", "insufficient_pool", "awaiting_diagnosis"]),
    questionVersionId: z.uuid().nullable(),
    goal: practiceGoalSchema,
    difficulty: difficultyBandSchema.nullable(),
    policyVersion: z.string(),
    profileVersion: z.number().int().positive(),
    explanation: z.string(),
    baselineId: z.uuid().nullable(),
  })
  .strict();

export type PracticeDecisionDTO = z.infer<typeof practiceDecisionSchema>;

export const profileQuerySchema = z
  .object({ skillId: z.uuid().optional() })
  .strict();

export type ProfileQuery = z.infer<typeof profileQuerySchema>;
