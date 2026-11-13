import { z } from "zod";

export const TIMING_LIMITS = {
  maxBatchEvents: 20,
  maxEpisodeEvents: 2000,
  checkpointMs: 15_000,
  leaseMs: 60_000,
} as const;

export type TimingQuality = "reliable" | "partial" | "unusable" | "missing";
export type TimingPhase = "initial" | "self_check" | "post_hint";
export type TimingEventKind = "start" | "checkpoint" | "pause" | "resume" | "finish";

export const timingQualitySchema = z.enum([
  "reliable",
  "partial",
  "unusable",
  "missing",
]);
export const timingPhaseSchema = z.enum(["initial", "self_check", "post_hint"]);
export const timingEventKindSchema = z.enum([
  "start",
  "checkpoint",
  "pause",
  "resume",
  "finish",
]);
export const timingSegmentQualitySchema = z.enum([
  "reliable",
  "partial",
  "unusable",
]);

export const timingEventSchema = z
  .object({
    eventId: z.uuid(),
    episodeId: z.uuid(),
    leaseEpoch: z.number().int().positive(),
    seq: z.number().int().positive(),
    segmentId: z.uuid(),
    kind: timingEventKindSchema,
    cumulativeActiveMs: z.number().int().nonnegative(),
    phase: timingPhaseSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const timingEventBatchSchema = z
  .array(timingEventSchema)
  .min(1)
  .max(TIMING_LIMITS.maxBatchEvents);

export type TimingEventInput = z.infer<typeof timingEventSchema>;
export type TimingEventBatch = z.infer<typeof timingEventBatchSchema>;

export const timingSegmentSchema = z
  .object({
    id: z.uuid(),
    phase: timingPhaseSchema,
    startAt: z.iso.datetime(),
    endAt: z.iso.datetime().nullable(),
    acceptedMs: z.number().int().nonnegative(),
    quality: timingSegmentQualitySchema,
  })
  .strict();

export type TimingSegment = z.infer<typeof timingSegmentSchema>;

export const timingSummarySchema = z
  .object({
    firstAttemptMs: z.number().int().nonnegative().nullable(),
    selfCheckMs: z.number().int().nonnegative().nullable(),
    postHintMs: z.number().int().nonnegative().nullable(),
    totalActiveMs: z.number().int().nonnegative().nullable(),
    wallMs: z.number().int().nonnegative().nullable(),
    quality: timingQualitySchema,
    reasonCodes: z.array(z.string()),
  })
  .strict();

export type TimingSummary = z.infer<typeof timingSummarySchema>;

export const EMPTY_TIMING_SUMMARY: TimingSummary = {
  firstAttemptMs: null,
  selfCheckMs: null,
  postHintMs: null,
  totalActiveMs: null,
  wallMs: null,
  quality: "missing",
  reasonCodes: ["not_collected"],
};

/** Server-side timing snapshot used by the pure reducer. */
export const timingStateSchema = z
  .object({
    episodeId: z.uuid(),
    state: z.enum(["active", "paused", "finished"]),
    leaseEpoch: z.number().int().positive(),
    version: z.number().int().positive(),
    lastSeq: z.number().int().nonnegative(),
    segmentId: z.uuid().nullable(),
    lastReceivedAt: z.iso.datetime().nullable(),
    lastCumulativeMs: z.number().int().nonnegative(),
    firstSubmittedAt: z.iso.datetime().nullable(),
    phase: timingPhaseSchema,
    reasons: z.array(z.string()),
  })
  .strict();

export type TimingState = z.infer<typeof timingStateSchema>;

export type TimingReduction = {
  state: TimingState;
  acceptedMs: number;
  duplicate: boolean;
};

export const timingReductionSchema = z
  .object({
    state: timingStateSchema,
    acceptedMs: z.number().int().nonnegative(),
    duplicate: z.boolean(),
  })
  .strict();
