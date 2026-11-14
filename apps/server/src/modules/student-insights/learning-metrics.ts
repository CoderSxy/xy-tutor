import type {
  EvaluationFirstAttemptFact,
  EvaluationDiagnosisFact,
  GroupReference,
  LearningEvaluationFacts,
  LearningMetrics,
  MetricRatio,
} from "../../../../../packages/contracts/src/learning-evaluation.js";
import { BASELINE_MIN_SAMPLES } from "../learning-profile/efficiency.js";

const GROUP_MIN_STUDENTS = 30;
const GROUP_MIN_SAMPLES = 100;
const GROUP_MAX_SAMPLES_PER_STUDENT = 5;

export function ratio(numerator: number, denominator: number): MetricRatio {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
  };
}

function ratioLayer(entries: Array<[string | null, boolean]>): Record<string, MetricRatio> {
  const counts = new Map<string, { numerator: number; denominator: number }>();
  for (const [key, success] of entries) {
    if (key === null) continue;
    const current = counts.get(key) ?? { numerator: 0, denominator: 0 };
    current.denominator += 1;
    if (success) current.numerator += 1;
    counts.set(key, current);
  }
  const result: Record<string, MetricRatio> = {};
  for (const key of [...counts.keys()].sort()) {
    const { numerator, denominator } = counts.get(key)!;
    result[key] = ratio(numerator, denominator);
  }
  return result;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function isIndependent(attempt: EvaluationFirstAttemptFact): boolean {
  return attempt.exposure === "none" && !attempt.priorExposure;
}

function isIndependentNew(attempt: EvaluationFirstAttemptFact): boolean {
  return attempt.firstEncounter && attempt.determinable && isIndependent(attempt);
}

function isEfficiencySample(attempt: EvaluationFirstAttemptFact): boolean {
  return (
    isIndependentNew(attempt) &&
    attempt.correct &&
    attempt.timingQuality === "reliable" &&
    attempt.timingMs !== null &&
    attempt.bucketKey !== null
  );
}

function diagnosisLayer(
  facts: LearningEvaluationFacts,
  keyOf: (row: EvaluationDiagnosisFact) => string | null,
) {
  const reviewed = uniqueBy(
    facts.diagnoses.filter(
      (row) => row.diagnosable && row.status === "confirmed" && row.reviewDecision !== null,
    ),
    (row) => row.attemptId,
  );
  return ratioLayer(
    reviewed.map((row) => [keyOf(row), row.reviewedAcceptedPrimary] as [string | null, boolean]),
  );
}

export function computeLearningMetrics(
  facts: LearningEvaluationFacts,
): LearningMetrics {
  const attempts = uniqueBy(facts.firstAttempts, (row) => row.attemptId);

  const reviewedConfirmed = facts.diagnoses.filter((row) => row.diagnosable);

  const confirmedRows = uniqueBy(
    reviewedConfirmed.filter(
      (row) => row.status === "confirmed" && row.reviewDecision !== null,
    ),
    (row) => row.attemptId,
  );
  const confirmedDiagnosis = ratio(
    confirmedRows.filter((row) => row.reviewedAcceptedPrimary).length,
    confirmedRows.length,
  );
  const diagnosisCoverage = ratio(
    uniqueBy(
      reviewedConfirmed.filter((row) => row.status === "confirmed"),
      (row) => row.attemptId,
    ).length,
    reviewedConfirmed.length,
  );
  const diagnosisGaps = {
    unsupported: uniqueBy(
      reviewedConfirmed.filter((row) => row.status === "unsupported"),
      (row) => row.attemptId,
    ).length,
    insufficient: uniqueBy(
      reviewedConfirmed.filter((row) => row.reviewDecision === "insufficient"),
      (row) => row.attemptId,
    ).length,
  };

  const rounds = uniqueBy(
    facts.selfCheckRounds,
    (row) => `${row.episodeId}:${row.roundNo}`,
  );
  const selfCheckWon = (outcome: string, verified: boolean) =>
    outcome === "resolved" && verified;
  const selfCheckSuccess = {
    overall: ratio(
      rounds.filter((row) => selfCheckWon(row.outcome, row.verifiedCorrection)).length,
      rounds.length,
    ),
    byAnchor: ratioLayer(
      rounds.map(
        (row) =>
          [
            row.anchorCode ?? "unattributed",
            selfCheckWon(row.outcome, row.verifiedCorrection),
          ] as [string | null, boolean],
      ),
    ),
    byHintLevel: ratioLayer(
      rounds.map(
        (row) =>
          [row.hintLevel, selfCheckWon(row.outcome, row.verifiedCorrection)] as [
            string | null,
            boolean,
          ],
      ),
    ),
  };

  const newAttempts = attempts.filter((row) => row.firstEncounter && row.determinable);
  const independentCandidates = newAttempts.filter(isIndependent);
  const independentNewCorrect = ratio(
    independentCandidates.filter((row) => row.correct).length,
    independentCandidates.length,
  );
  const independentCoverage = ratio(independentCandidates.length, newAttempts.length);

  const hintDependency: Record<string, number> = {};
  for (const row of attempts) {
    hintDependency[row.exposure] = (hintDependency[row.exposure] ?? 0) + 1;
  }

  const reviews = uniqueBy(facts.delayedReviews, (row) => row.mistakeId);
  const completed = reviews.filter((row) => row.completed);
  const delayedReview = {
    completion: ratio(completed.length, reviews.length),
    pass: ratio(
      completed.filter((row) => row.independentPass === true).length,
      completed.filter((row) => row.independentPass !== null).length,
    ),
  };

  const timed = attempts.filter(
    (row) =>
      row.timingMs !== null &&
      row.timingQuality !== "missing" &&
      row.timingQuality !== "unusable",
  );
  const timingReasons: Record<string, number> = {};
  for (const row of attempts) {
    for (const code of row.timingReasonCodes) {
      timingReasons[code] = (timingReasons[code] ?? 0) + 1;
    }
  }
  const timing = {
    coverage: ratio(timed.length, attempts.length),
    reliable: ratio(
      attempts.filter((row) => row.timingQuality === "reliable").length,
      attempts.length,
    ),
    reasons: timingReasons,
  };

  const baselineByBucket = new Map(facts.baselines.map((row) => [row.bucketKey, row]));
  const buckets = new Map<string, number[]>();
  for (const row of attempts) {
    if (!isEfficiencySample(row)) continue;
    const times = buckets.get(row.bucketKey!) ?? [];
    times.push(row.timingMs!);
    buckets.set(row.bucketKey!, times);
  }
  const efficiency = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucketKey, times]) => {
      const baseline = baselineByBucket.get(bucketKey);
      const reasonCodes: string[] = [];
      if (times.length < BASELINE_MIN_SAMPLES) reasonCodes.push("SAMPLES_BELOW_MINIMUM");
      if (!baseline) reasonCodes.push("BASELINE_MISSING");
      const sampleMedian = median(times);
      const comparable = reasonCodes.length === 0;
      return {
        bucketKey,
        skillId: attempts.find((row) => row.bucketKey === bucketKey)?.skillId ?? null,
        sampleCount: times.length,
        medianMs: sampleMedian,
        baselineMedianMs: baseline ? baseline.medianMs : null,
        baselineSampleCount: baseline ? baseline.sampleCount : 0,
        changeRatio:
          comparable && baseline ? sampleMedian / baseline.medianMs - 1 : null,
        comparable,
        reasonCodes,
      };
    });

  const questions = uniqueBy(facts.questionQuality, (row) => row.questionVersionId);
  const reviewedQuestions = questions.filter((row) => row.reviewed);
  const questionQuality = ratio(
    reviewedQuestions.filter((row) => row.confirmedProblem).length,
    reviewedQuestions.length,
  );

  return {
    confirmedDiagnosis: {
      overall: confirmedDiagnosis,
      byCode: diagnosisLayer(facts, (row) => row.primaryCode),
      byQuestionType: diagnosisLayer(facts, (row) => row.questionType),
      bySource: diagnosisLayer(facts, (row) => row.source),
      byRuleVersion: diagnosisLayer(facts, (row) => row.ruleVersion),
    },
    diagnosisCoverage,
    diagnosisGaps,
    selfCheckSuccess,
    independentNewCorrect,
    independentCoverage,
    hintDependency,
    delayedReview,
    timing,
    efficiency,
    questionQuality,
  };
}

export function computeGroupReference(
  facts: LearningEvaluationFacts,
): GroupReference {
  if (!facts.groupReferenceEnabled) {
    return {
      enabled: false,
      available: false,
      studentCount: 0,
      sampleCount: 0,
      maxSamplesPerStudent: GROUP_MAX_SAMPLES_PER_STUDENT,
      reasonCodes: ["DISABLED"],
    };
  }
  const capped = new Map<string, Set<string>>();
  for (const sample of facts.groupSamples) {
    const keys = capped.get(sample.studentId) ?? new Set<string>();
    if (keys.size >= GROUP_MAX_SAMPLES_PER_STUDENT) continue;
    if (keys.has(sample.sampleKey)) continue;
    keys.add(sample.sampleKey);
    capped.set(sample.studentId, keys);
  }
  const studentCount = capped.size;
  const sampleCount = [...capped.values()].reduce((sum, keys) => sum + keys.size, 0);
  const reasonCodes: string[] = [];
  if (studentCount < GROUP_MIN_STUDENTS) reasonCodes.push("STUDENTS_BELOW_MINIMUM");
  if (sampleCount < GROUP_MIN_SAMPLES) reasonCodes.push("SAMPLES_BELOW_MINIMUM");
  return {
    enabled: true,
    available: reasonCodes.length === 0,
    studentCount,
    sampleCount,
    maxSamplesPerStudent: GROUP_MAX_SAMPLES_PER_STUDENT,
    reasonCodes,
  };
}
