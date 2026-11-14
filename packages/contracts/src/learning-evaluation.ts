import { z } from "zod";
import { evidenceRefSchema } from "./evidence.js";
import { diagnosisCodeSchema } from "./tutoring.js";

export const diagnosisReviewInputSchema = z
  .object({
    diagnosisId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    decision: z.enum(["accept", "correct", "insufficient"]),
    correctedCode: diagnosisCodeSchema.nullable(),
    reason: z.string().trim().min(1).max(2000),
    evidence: z.array(evidenceRefSchema).max(20),
    requestKey: z.string().trim().min(1).max(120),
  })
  .strict()
  .refine(
    (value) => value.decision !== "correct" || value.correctedCode !== null,
    { message: "纠正诊断必须指定错因代码", path: ["correctedCode"] },
  )
  .refine(
    (value) => value.decision === "correct" || value.correctedCode === null,
    { message: "只有纠正诊断才能指定错因代码", path: ["correctedCode"] },
  );

export type DiagnosisReviewInput = z.infer<typeof diagnosisReviewInputSchema>;

export const evaluationWindowSchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .strict();

export type EvaluationWindow = z.infer<typeof evaluationWindowSchema>;

const ratioSchema = z
  .object({
    numerator: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
  })
  .strict();

export type MetricRatio = z.infer<typeof ratioSchema>;

export const learningMetricsSchema = z
  .object({
    confirmedDiagnosis: ratioSchema,
    diagnosisCoverage: ratioSchema,
    selfCheckSuccess: ratioSchema,
    independentNewCorrect: ratioSchema,
    independentCoverage: ratioSchema,
    delayedReviewCompletion: ratioSchema,
    delayedReviewPass: ratioSchema,
    hintDependency: z.record(z.string(), z.number().int().nonnegative()),
    timingReliable: ratioSchema,
    timingCoverage: ratioSchema,
    questionQuality: ratioSchema,
  })
  .strict();

export type LearningMetrics = z.infer<typeof learningMetricsSchema>;

export const learningEvaluationSchema = z
  .object({
    studentId: z.uuid(),
    from: z.iso.date(),
    to: z.iso.date(),
    metrics: learningMetricsSchema,
    sampleSize: z.number().int().nonnegative(),
    versions: z.record(z.string(), z.string()),
    generatedAt: z.iso.datetime(),
    staleEvidenceCount: z.number().int().nonnegative(),
  })
  .strict();

export type LearningEvaluationDTO = z.infer<typeof learningEvaluationSchema>;
