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
    value: z.number().min(0).max(1).nullable(),
  })
  .strict();

export type MetricRatio = z.infer<typeof ratioSchema>;

const ratioLayersSchema = z.record(z.string(), ratioSchema);

const countsSchema = z.record(z.string(), z.number().int().nonnegative());

export const learningMetricsSchema = z
  .object({
    confirmedDiagnosis: z
      .object({
        overall: ratioSchema,
        byCode: ratioLayersSchema,
        byQuestionType: ratioLayersSchema,
        bySource: ratioLayersSchema,
        byRuleVersion: ratioLayersSchema,
      })
      .strict(),
    diagnosisCoverage: ratioSchema,
    diagnosisGaps: z
      .object({
        unsupported: z.number().int().nonnegative(),
        insufficient: z.number().int().nonnegative(),
      })
      .strict(),
    selfCheckSuccess: z
      .object({
        overall: ratioSchema,
        byAnchor: ratioLayersSchema,
        byHintLevel: ratioLayersSchema,
      })
      .strict(),
    independentNewCorrect: ratioSchema,
    independentCoverage: ratioSchema,
    hintDependency: countsSchema,
    delayedReview: z
      .object({
        completion: ratioSchema,
        pass: ratioSchema,
      })
      .strict(),
    timing: z
      .object({
        coverage: ratioSchema,
        reliable: ratioSchema,
        reasons: countsSchema,
      })
      .strict(),
    efficiency: z.array(
      z
        .object({
          bucketKey: z.string(),
          skillId: z.string().nullable(),
          sampleCount: z.number().int().nonnegative(),
          medianMs: z.number().int().nonnegative().nullable(),
          baselineMedianMs: z.number().int().nonnegative().nullable(),
          baselineSampleCount: z.number().int().nonnegative(),
          changeRatio: z.number().nullable(),
          comparable: z.boolean(),
          reasonCodes: z.array(z.string()),
        })
        .strict(),
    ),
    questionQuality: ratioSchema,
  })
  .strict();

export type LearningMetrics = z.infer<typeof learningMetricsSchema>;

export const groupReferenceSchema = z
  .object({
    enabled: z.boolean(),
    available: z.boolean(),
    studentCount: z.number().int().nonnegative(),
    sampleCount: z.number().int().nonnegative(),
    maxSamplesPerStudent: z.number().int().positive(),
    reasonCodes: z.array(z.string()),
  })
  .strict();

export type GroupReference = z.infer<typeof groupReferenceSchema>;

export const baselineEvidenceSchema = z
  .object({
    bucketKey: z.string(),
    skillId: z.uuid().nullable(),
    medianMs: z.number().int().positive(),
    sampleCount: z.number().int().nonnegative(),
    asOf: z.iso.datetime(),
    policyVersion: z.string(),
  })
  .strict();

export type BaselineEvidence = z.infer<typeof baselineEvidenceSchema>;

export const learningEvaluationSchema = z
  .object({
    studentId: z.uuid(),
    from: z.iso.date(),
    to: z.iso.date(),
    metrics: learningMetricsSchema,
    sampleSize: z.number().int().nonnegative(),
    baselines: z.array(baselineEvidenceSchema),
    groupReference: groupReferenceSchema,
    versions: z.record(z.string(), z.string()),
    dataAsOf: z.iso.datetime(),
    generatedAt: z.iso.datetime(),
    staleEvidenceCount: z.number().int().nonnegative(),
  })
  .strict();

export type LearningEvaluationDTO = z.infer<typeof learningEvaluationSchema>;

export type EvaluationFirstAttemptFact = {
  attemptId: string;
  questionVersionId: string;
  skillId: string | null;
  bucketKey: string | null;
  exposure: "none" | "guided" | "solution_exposed" | "unknown";
  priorExposure: boolean;
  firstEncounter: boolean;
  determinable: boolean;
  correct: boolean;
  timingQuality: "reliable" | "partial" | "unusable" | "missing";
  timingMs: number | null;
  timingReasonCodes: string[];
};

export type EvaluationSelfCheckFact = {
  episodeId: string;
  roundNo: number;
  outcome: "resolved" | "unresolved" | "exited";
  verifiedCorrection: boolean;
  anchorCode: string | null;
  hintLevel: "none" | "hint" | "answer";
};

export type EvaluationDelayedReviewFact = {
  mistakeId: string;
  dueAt: Date;
  completed: boolean;
  independentPass: boolean | null;
};

export type EvaluationDiagnosisFact = {
  attemptId: string;
  diagnosable: boolean;
  status: "pending" | "needs_probe" | "confirmed" | "unsupported" | "invalidated";
  primaryCode: string | null;
  questionType: string;
  source: string;
  ruleVersion: string;
  reviewDecision: "accept" | "correct" | "insufficient" | null;
  reviewedAcceptedPrimary: boolean;
};

export type EvaluationQuestionQualityFact = {
  questionVersionId: string;
  reviewed: boolean;
  confirmedProblem: boolean;
};

export type EvaluationBaselineFact = {
  bucketKey: string;
  skillId: string | null;
  medianMs: number;
  sampleCount: number;
  asOf: Date;
  policyVersion: string;
};

export type EvaluationGroupSampleFact = {
  studentId: string;
  sampleKey: string;
};

export type LearningEvaluationFacts = {
  firstAttempts: EvaluationFirstAttemptFact[];
  selfCheckRounds: EvaluationSelfCheckFact[];
  delayedReviews: EvaluationDelayedReviewFact[];
  diagnoses: EvaluationDiagnosisFact[];
  baselines: EvaluationBaselineFact[];
  questionQuality: EvaluationQuestionQualityFact[];
  groupSamples: EvaluationGroupSampleFact[];
  groupReferenceEnabled: boolean;
  versions: Record<string, string>;
  dataAsOf: Date;
  staleEvidenceCount: number;
};
