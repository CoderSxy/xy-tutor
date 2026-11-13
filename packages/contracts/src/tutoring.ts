import { z } from "zod";
import { evidenceRefSchema } from "./evidence.js";
import {
  timingSummarySchema,
  timingEventSchema,
} from "./learning-timing.js";

export type Exposure = "none" | "guided" | "solution_exposed" | "unknown";
export type DiagnosisCode =
  | "execution_slip"
  | "condition_omission"
  | "concept_gap"
  | "rule_misuse"
  | "strategy_gap"
  | "expression_gap"
  | "input_issue";
export type DiagnosisStatus =
  | "pending"
  | "needs_probe"
  | "confirmed"
  | "unsupported"
  | "invalidated";
export type TeachingState =
  | "awaiting_evidence"
  | "self_check"
  | "focused_check"
  | "micro_probe"
  | "explanation"
  | "independent_check"
  | "scheduled_review";

export const exposureSchema = z.enum([
  "none",
  "guided",
  "solution_exposed",
  "unknown",
]);
export const diagnosisCodeSchema = z.enum([
  "execution_slip",
  "condition_omission",
  "concept_gap",
  "rule_misuse",
  "strategy_gap",
  "expression_gap",
  "input_issue",
]);
export const diagnosisStatusSchema = z.enum([
  "pending",
  "needs_probe",
  "confirmed",
  "unsupported",
  "invalidated",
]);
export const teachingStateSchema = z.enum([
  "awaiting_evidence",
  "self_check",
  "focused_check",
  "micro_probe",
  "explanation",
  "independent_check",
  "scheduled_review",
]);
export const tutoringActionKindSchema = z.enum([
  "request_hint",
  "request_probe",
  "request_example",
  "request_explanation",
  "acknowledge_display",
  "pause",
  "resume",
]);

export const episodeSchema = z
  .object({
    id: z.uuid(),
    studentId: z.uuid(),
    taskId: z.uuid(),
    questionVersionId: z.uuid(),
    version: z.number().int().positive(),
    leaseEpoch: z.number().int().positive(),
    lastSeq: z.number().int().nonnegative(),
    state: z.enum(["active", "paused", "finished"]),
    teachingState: teachingStateSchema,
    exposure: exposureSchema,
    leaseExpiresAt: z.iso.datetime(),
    serverAt: z.iso.datetime(),
    priorExposure: z.boolean(),
    timing: timingSummarySchema,
  })
  .strict();

export type EpisodeDTO = z.infer<typeof episodeSchema>;

export const diagnosisCandidateSchema = z
  .object({
    code: diagnosisCodeSchema,
    skillId: z.uuid().nullable(),
    status: z.enum(["hypothesis", "supported", "confirmed", "rejected"]),
    earliestError: evidenceRefSchema.nullable(),
    supports: z.array(evidenceRefSchema),
    contradicts: z.array(evidenceRefSchema),
    probe: z.string().nullable(),
  })
  .strict();

export type DiagnosisCandidate = z.infer<typeof diagnosisCandidateSchema>;

export const diagnosisSchema = z
  .object({
    id: z.uuid(),
    attemptId: z.uuid(),
    version: z.number().int().positive(),
    status: diagnosisStatusSchema,
    primaryCode: diagnosisCodeSchema.nullable(),
    candidates: z.array(diagnosisCandidateSchema).max(3),
    summary: z.string(),
    evidence: z.array(evidenceRefSchema),
    ruleVersion: z.string(),
  })
  .strict();

export type DiagnosisDTO = z.infer<typeof diagnosisSchema>;

export const tutoringActionInputSchema = z
  .object({
    requestKey: z.string().trim().min(1).max(120),
    expectedVersion: z.number().int().positive(),
    kind: tutoringActionKindSchema,
    actionId: z.uuid().optional(),
  })
  .strict();

export type TutoringActionInput = z.infer<typeof tutoringActionInputSchema>;

export const tutoringActionSchema = z
  .object({
    id: z.uuid(),
    episodeId: z.uuid(),
    stateVersion: z.number().int().positive(),
    state: teachingStateSchema,
    exposure: exposureSchema,
    displayStatus: z.enum(["created", "sent", "acknowledged", "unknown"]),
    content: z.string(),
    evidence: z.array(evidenceRefSchema),
  })
  .strict();

export type TutoringActionDTO = z.infer<typeof tutoringActionSchema>;

export const episodeStartInputSchema = z
  .object({
    taskId: z.uuid(),
    questionVersionId: z.uuid(),
    requestKey: z.string().trim().min(1).max(120),
    takeOver: z.boolean().optional(),
  })
  .strict();

export type EpisodeStartInput = z.infer<typeof episodeStartInputSchema>;

export type DiagnosisContext = {
  assessmentId: string;
  attemptId: string;
  questionVersionId: string;
  processEvidence: { kind: string; id: string; versionId?: string }[];
  probeEvidence: { kind: string; id: string; versionId?: string }[];
};

export type TeachingTransitionInput = {
  episode: EpisodeDTO;
  diagnosis: DiagnosisDTO | null;
  action: TutoringActionInput;
  failedChecks: number;
};

/** Optional attempt fields added by phase one; old clients omit them. */
export const attemptTimingInputSchema = z
  .object({
    episodeId: z.uuid().optional(),
    timingFinalEvent: timingEventSchema.optional(),
    processMessageVersionId: z.uuid().optional(),
  })
  .strict();

export type AttemptTimingInput = z.infer<typeof attemptTimingInputSchema>;

export const episodeEventsInputSchema = z
  .object({
    events: z.array(timingEventSchema).min(1).max(20),
  })
  .strict();

export type EpisodeEventsInput = z.infer<typeof episodeEventsInputSchema>;
