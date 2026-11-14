import type { EfficiencyObservation } from "../../../../../packages/contracts/src/learning-profile.js";

export const BASELINE_POLICY_VERSION = "efficiency-v1";
export const BASELINE_WINDOW_DAYS = 30;
export const BASELINE_MAX_SAMPLES = 20;
export const BASELINE_MIN_SAMPLES = 5;
export const BASELINE_MIN_VERSIONS = 5;
export const BASELINE_MIN_DATES = 2;
export const BASELINE_MIN_FAMILIES = 2;
export const FASTER_RATIO = 0.75;
export const SLOWER_RATIO = 1.5;

export type EfficiencySample = {
  id: string;
  studentId: string;
  skillId: string;
  questionVersionId: string;
  difficultyBand: "easy" | "medium" | "challenge";
  answerType: string;
  complexityBand: number;
  templateFamily: string;
  attemptAt: Date;
  firstAttemptMs: number | null;
  quality: "reliable" | "partial" | "unusable" | "missing";
  verification: string;
  correctness: string;
  hintDependency: "none" | "guided" | "solution_exposed" | "unknown";
  exposure: "none" | "guided" | "solution_exposed" | "unknown";
  firstEncounter: boolean;
  redo: boolean;
};

export type EfficiencyBaselinePlan = {
  bucketKey: string;
  eligible: EfficiencySample[];
  sampleIds: string[];
  medianMs: number | null;
  windowStart: Date;
  windowEnd: Date;
  reasonCodes: string[];
  policyVersion: string;
};

export function efficiencyBucketKey(sample: {
  skillId: string;
  difficultyBand: string;
  answerType: string;
  complexityBand: number;
}): string {
  return [
    sample.skillId,
    sample.difficultyBand,
    sample.answerType,
    sample.complexityBand,
  ].join("|");
}

function sameBucket(a: EfficiencySample, b: EfficiencySample): boolean {
  return (
    a.studentId === b.studentId &&
    a.skillId === b.skillId &&
    a.difficultyBand === b.difficultyBand &&
    a.answerType === b.answerType &&
    a.complexityBand === b.complexityBand
  );
}

function usable(sample: EfficiencySample, current: EfficiencySample): boolean {
  if (sample.id === current.id) return false;
  if (!sameBucket(sample, current)) return false;
  if (!(sample.attemptAt < current.attemptAt)) return false;
  if (sample.quality !== "reliable") return false;
  if (sample.firstAttemptMs === null || sample.firstAttemptMs <= 0) return false;
  if (sample.verification !== "verified") return false;
  if (sample.correctness !== "correct") return false;
  if (sample.hintDependency !== "none") return false;
  if (sample.exposure !== "none") return false;
  if (!sample.firstEncounter || sample.redo) return false;
  return true;
}

function currentEligible(sample: EfficiencySample): boolean {
  return (
    sample.verification === "verified" &&
    sample.correctness === "correct" &&
    sample.quality === "reliable" &&
    sample.firstAttemptMs !== null &&
    sample.firstAttemptMs > 0 &&
    sample.exposure === "none" &&
    sample.hintDependency === "none" &&
    sample.firstEncounter &&
    !sample.redo
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export function baselineFor(
  current: EfficiencySample,
  samples: EfficiencySample[],
): EfficiencyBaselinePlan {
  const windowEnd = current.attemptAt;
  const windowStart = new Date(
    windowEnd.getTime() - BASELINE_WINDOW_DAYS * 86_400_000,
  );
  const eligible = samples
    .filter(
      (sample) =>
        usable(sample, current) && sample.attemptAt >= windowStart,
    )
    .sort((a, b) => b.attemptAt.getTime() - a.attemptAt.getTime())
    .slice(0, BASELINE_MAX_SAMPLES);
  const reasons: string[] = [];
  const versions = new Set(eligible.map((item) => item.questionVersionId));
  const dates = new Set(
    eligible.map((item) => item.attemptAt.toISOString().slice(0, 10)),
  );
  const families = new Set(eligible.map((item) => item.templateFamily));
  if (eligible.length < BASELINE_MIN_SAMPLES)
    reasons.push("SAMPLES_BELOW_MINIMUM");
  if (versions.size < BASELINE_MIN_VERSIONS)
    reasons.push("VERSIONS_BELOW_MINIMUM");
  if (dates.size < BASELINE_MIN_DATES) reasons.push("DATES_BELOW_MINIMUM");
  if (families.size < BASELINE_MIN_FAMILIES)
    reasons.push("FAMILIES_BELOW_MINIMUM");
  reasons.sort();
  return {
    bucketKey: efficiencyBucketKey(current),
    eligible,
    sampleIds: eligible.map((item) => item.id),
    medianMs:
      reasons.length === 0
        ? median(eligible.map((item) => item.firstAttemptMs!))
        : null,
    windowStart,
    windowEnd,
    reasonCodes: reasons,
    policyVersion: BASELINE_POLICY_VERSION,
  };
}

export function observeEfficiency(
  current: EfficiencySample,
  samples: EfficiencySample[],
  baselineId: string | null = null,
): EfficiencyObservation {
  const plan = baselineFor(current, samples);
  if (!currentEligible(current)) {
    return {
      status: "ineligible",
      baselineId,
      sampleCount: plan.eligible.length,
      medianMs: plan.medianMs,
      timeRatio: null,
      direction: null,
      reasonCodes: ["CURRENT_SAMPLE_INELIGIBLE"],
    };
  }
  if (plan.medianMs === null) {
    return {
      status: "insufficient_samples",
      baselineId,
      sampleCount: plan.eligible.length,
      medianMs: null,
      timeRatio: null,
      direction: null,
      reasonCodes: plan.reasonCodes,
    };
  }
  const timeRatio =
    Math.round(
      (current.firstAttemptMs! / plan.medianMs) * 10_000,
    ) / 10_000;
  return {
    status: "observed",
    baselineId,
    sampleCount: plan.eligible.length,
    medianMs: plan.medianMs,
    timeRatio,
    direction:
      timeRatio < FASTER_RATIO
        ? "faster"
        : timeRatio > SLOWER_RATIO
          ? "slower"
          : "comparable",
    reasonCodes: [],
  };
}
