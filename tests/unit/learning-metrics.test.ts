import { describe, expect, it } from "vitest";
import {
  computeLearningMetrics,
  computeGroupReference,
} from "../../apps/server/src/modules/student-insights/learning-metrics.js";
import type {
  EvaluationBaselineFact,
  EvaluationDelayedReviewFact,
  EvaluationDiagnosisFact,
  EvaluationFirstAttemptFact,
  EvaluationSelfCheckFact,
  LearningEvaluationFacts,
} from "../../packages/contracts/src/learning-evaluation.js";

function attempt(
  overrides: Partial<EvaluationFirstAttemptFact> = {},
): EvaluationFirstAttemptFact {
  return {
    attemptId: "attempt-1",
    questionVersionId: "version-1",
    skillId: "skill-1",
    bucketKey: "skill-1|medium|numeric|2",
    exposure: "none",
    priorExposure: false,
    firstEncounter: true,
    determinable: true,
    correct: true,
    timingQuality: "reliable",
    timingMs: 60_000,
    timingReasonCodes: [],
    ...overrides,
  };
}

function selfCheck(
  roundNo: number,
  overrides: Partial<EvaluationSelfCheckFact> = {},
): EvaluationSelfCheckFact {
  return {
    episodeId: "episode-1",
    roundNo,
    outcome: "resolved",
    verifiedCorrection: true,
    anchorCode: "sign_error",
    hintLevel: "none",
    ...overrides,
  };
}

function review(
  index: number,
  overrides: Partial<EvaluationDelayedReviewFact> = {},
): EvaluationDelayedReviewFact {
  return {
    mistakeId: `mistake-${index}`,
    dueAt: new Date("2026-11-01T00:00:00Z"),
    completed: true,
    independentPass: true,
    ...overrides,
  };
}

function diagnosis(
  index: number,
  overrides: Partial<EvaluationDiagnosisFact> = {},
): EvaluationDiagnosisFact {
  return {
    attemptId: `attempt-${index}`,
    diagnosable: true,
    status: "confirmed",
    primaryCode: "concept_gap",
    questionType: "numeric",
    source: "practice",
    ruleVersion: "diagnosis-v1",
    reviewDecision: "accept",
    reviewedAcceptedPrimary: true,
    ...overrides,
  };
}

function baseline(
  overrides: Partial<EvaluationBaselineFact> = {},
): EvaluationBaselineFact {
  return {
    bucketKey: "skill-1|medium|numeric|2",
    skillId: "skill-1",
    medianMs: 120_000,
    sampleCount: 5,
    asOf: new Date("2026-10-01T00:00:00Z"),
    policyVersion: "efficiency-v1",
    ...overrides,
  };
}

function facts(
  overrides: Partial<LearningEvaluationFacts> = {},
): LearningEvaluationFacts {
  return {
    firstAttempts: [],
    selfCheckRounds: [],
    delayedReviews: [],
    diagnoses: [],
    baselines: [],
    questionQuality: [],
    groupSamples: [],
    groupReferenceEnabled: false,
    versions: {},
    dataAsOf: new Date("2026-11-14T00:00:00Z"),
    staleEvidenceCount: 0,
    ...overrides,
  };
}

describe("self-check success", () => {
  it("keeps exits in the denominator and counts only verified corrections", () => {
    const rounds = [
      selfCheck(1),
      selfCheck(2),
      selfCheck(3),
      selfCheck(4),
      selfCheck(5, { outcome: "exited", verifiedCorrection: false }),
      selfCheck(6, { outcome: "exited", verifiedCorrection: false }),
      selfCheck(7, { outcome: "unresolved", verifiedCorrection: false }),
      selfCheck(8, { outcome: "unresolved", verifiedCorrection: false }),
      selfCheck(9, { outcome: "resolved", verifiedCorrection: false }),
      selfCheck(10, { outcome: "resolved", verifiedCorrection: false }),
    ];
    const metrics = computeLearningMetrics(
      facts({ selfCheckRounds: rounds }),
    );
    expect(metrics.selfCheckSuccess.overall).toEqual({
      numerator: 4,
      denominator: 10,
      value: 0.4,
    });
  });

  it("does not count the same round twice", () => {
    const metrics = computeLearningMetrics(
      facts({
        selfCheckRounds: [
          selfCheck(1),
          selfCheck(1),
          selfCheck(2, { outcome: "exited", verifiedCorrection: false }),
        ],
      }),
    );
    expect(metrics.selfCheckSuccess.overall).toEqual({
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
  });

  it("layers by anchor and hint level", () => {
    const metrics = computeLearningMetrics(
      facts({
        selfCheckRounds: [
          selfCheck(1, { anchorCode: "sign_error" }),
          selfCheck(2, {
            anchorCode: "sign_error",
            verifiedCorrection: false,
            outcome: "unresolved",
          }),
          selfCheck(3, { anchorCode: "carry_error", hintLevel: "hint" }),
        ],
      }),
    );
    expect(metrics.selfCheckSuccess.byAnchor.sign_error).toEqual({
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
    expect(metrics.selfCheckSuccess.byAnchor.carry_error?.value).toBe(1);
    expect(metrics.selfCheckSuccess.byHintLevel.none?.value).toBe(0.5);
    expect(metrics.selfCheckSuccess.byHintLevel.hint?.value).toBe(1);
  });
});

describe("delayed review", () => {
  it("reports completion and pass against different denominators", () => {
    const reviews: EvaluationDelayedReviewFact[] = [];
    for (let index = 0; index < 6; index += 1) {
      reviews.push(
        review(index, { independentPass: index < 3 }),
      );
    }
    for (let index = 6; index < 10; index += 1) {
      reviews.push(review(index, { completed: false, independentPass: null }));
    }
    const metrics = computeLearningMetrics(
      facts({ delayedReviews: reviews }),
    );
    expect(metrics.delayedReview.completion).toEqual({
      numerator: 6,
      denominator: 10,
      value: 0.6,
    });
    expect(metrics.delayedReview.pass).toEqual({
      numerator: 3,
      denominator: 6,
      value: 0.5,
    });
  });

  it("excludes completed reviews with an undeterminable outcome from pass", () => {
    const metrics = computeLearningMetrics(
      facts({
        delayedReviews: [
          review(1, { independentPass: null }),
          review(2, { independentPass: null }),
          review(3, { independentPass: false }),
          review(4, { independentPass: true }),
        ],
      }),
    );
    expect(metrics.delayedReview.pass).toEqual({
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
  });
});

describe("independent new questions", () => {
  it("does not treat unknown exposure as independent", () => {
    const metrics = computeLearningMetrics(
      facts({
        firstAttempts: [
          attempt({ attemptId: "a", correct: true }),
          attempt({ attemptId: "b", exposure: "unknown" }),
          attempt({ attemptId: "c", exposure: "guided" }),
          attempt({ attemptId: "d", exposure: "solution_exposed" }),
        ],
      }),
    );
    expect(metrics.independentNewCorrect).toEqual({
      numerator: 1,
      denominator: 1,
      value: 1,
    });
    expect(metrics.independentCoverage).toEqual({
      numerator: 1,
      denominator: 4,
      value: 0.25,
    });
    expect(metrics.hintDependency).toEqual({
      none: 1,
      unknown: 1,
      guided: 1,
      solution_exposed: 1,
    });
  });

  it("excludes prior exposure from independence but keeps it in coverage", () => {
    const metrics = computeLearningMetrics(
      facts({
        firstAttempts: [
          attempt({ attemptId: "a", priorExposure: true }),
          attempt({ attemptId: "b" }),
        ],
      }),
    );
    expect(metrics.independentCoverage).toEqual({
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
  });

  it("ignores redoes and undeterminable answers", () => {
    const metrics = computeLearningMetrics(
      facts({
        firstAttempts: [
          attempt({ attemptId: "a", firstEncounter: false }),
          attempt({ attemptId: "b", determinable: false }),
          attempt({ attemptId: "c", correct: false }),
        ],
      }),
    );
    expect(metrics.independentNewCorrect).toEqual({
      numerator: 0,
      denominator: 1,
      value: 0,
    });
  });

  it("does not count a duplicated attempt twice", () => {
    const metrics = computeLearningMetrics(
      facts({
        firstAttempts: [attempt({ attemptId: "a" }), attempt({ attemptId: "a" })],
      }),
    );
    expect(metrics.independentNewCorrect.denominator).toBe(1);
  });
});

describe("diagnosis metrics", () => {
  it("measures confirmed precision only over reviewed confirmations", () => {
    const metrics = computeLearningMetrics(
      facts({
        diagnoses: [
          diagnosis(1),
          diagnosis(2),
          diagnosis(3, {
            primaryCode: "rule_misuse",
            reviewedAcceptedPrimary: false,
            reviewDecision: "correct",
          }),
          diagnosis(4, {
            status: "pending",
            reviewDecision: null,
            reviewedAcceptedPrimary: false,
          }),
        ],
      }),
    );
    expect(metrics.confirmedDiagnosis.overall).toEqual({
      numerator: 2,
      denominator: 3,
      value: 2 / 3,
    });
    expect(metrics.confirmedDiagnosis.byCode.concept_gap?.denominator).toBe(2);
    expect(metrics.confirmedDiagnosis.byCode.rule_misuse?.value).toBe(0);
  });

  it("reports coverage with unsupported and insufficient counts kept separate", () => {
    const metrics = computeLearningMetrics(
      facts({
        diagnoses: [
          diagnosis(1),
          diagnosis(2, { status: "unsupported", primaryCode: null }),
          diagnosis(3, {
            status: "pending",
            primaryCode: null,
            reviewDecision: "insufficient",
            reviewedAcceptedPrimary: false,
          }),
          diagnosis(4, { diagnosable: false, status: "invalidated" }),
        ],
      }),
    );
    expect(metrics.diagnosisCoverage).toEqual({
      numerator: 1,
      denominator: 3,
      value: 1 / 3,
    });
    expect(metrics.diagnosisGaps).toEqual({ unsupported: 1, insufficient: 1 });
  });
});

describe("timing metrics", () => {
  it("reports coverage and reliability over every formal attempt", () => {
    const metrics = computeLearningMetrics(
      facts({
        firstAttempts: [
          attempt({ attemptId: "a" }),
          attempt({
            attemptId: "b",
            timingQuality: "partial",
            timingReasonCodes: ["DEVICE_CHANGED"],
          }),
          attempt({
            attemptId: "c",
            timingQuality: "unusable",
            timingMs: null,
            timingReasonCodes: ["CLOCK_SKEW"],
          }),
          attempt({
            attemptId: "d",
            timingQuality: "missing",
            timingMs: null,
            timingReasonCodes: ["not_collected"],
          }),
        ],
      }),
    );
    expect(metrics.timing.coverage).toEqual({
      numerator: 2,
      denominator: 4,
      value: 0.5,
    });
    expect(metrics.timing.reliable).toEqual({
      numerator: 1,
      denominator: 4,
      value: 0.25,
    });
    expect(metrics.timing.reasons).toEqual({
      DEVICE_CHANGED: 1,
      CLOCK_SKEW: 1,
      not_collected: 1,
    });
  });
});

describe("efficiency buckets", () => {
  const eligible = (index: number, bucketKey: string, ms: number) =>
    attempt({
      attemptId: `attempt-${bucketKey}-${index}`,
      bucketKey,
      timingMs: ms,
      skillId: "skill-1",
    });

  it("keeps difficulty buckets separate instead of merging into one speedup", () => {
    const metrics = computeLearningMetrics(
      facts({
        firstAttempts: [
          ...Array.from({ length: 5 }, (_, index) =>
            eligible(index, "skill-1|medium|numeric|2", 1_000),
          ),
          ...Array.from({ length: 2 }, (_, index) =>
            eligible(index, "skill-1|easy|numeric|1", 500),
          ),
        ],
        baselines: [baseline()],
      }),
    );
    expect(metrics.efficiency).toHaveLength(2);
    const medium = metrics.efficiency.find(
      (row) => row.bucketKey === "skill-1|medium|numeric|2",
    );
    expect(medium).toMatchObject({
      sampleCount: 5,
      medianMs: 1_000,
      baselineMedianMs: 120_000,
      comparable: true,
      reasonCodes: [],
    });
    expect(medium?.changeRatio).toBeCloseTo(1_000 / 120_000 - 1);
    const easy = metrics.efficiency.find(
      (row) => row.bucketKey === "skill-1|easy|numeric|1",
    );
    expect(easy).toMatchObject({
      sampleCount: 2,
      comparable: false,
      baselineMedianMs: null,
      changeRatio: null,
    });
    expect(easy?.reasonCodes).toEqual([
      "SAMPLES_BELOW_MINIMUM",
      "BASELINE_MISSING",
    ]);
  });

  it("excludes guided, incorrect and partial-timing attempts from the trend", () => {
    const metrics = computeLearningMetrics(
      facts({
        firstAttempts: [
          eligible(0, "skill-1|medium|numeric|2", 1_000),
          attempt({
            attemptId: "guided",
            bucketKey: "skill-1|medium|numeric|2",
            exposure: "guided",
            timingMs: 100,
          }),
          attempt({
            attemptId: "wrong",
            bucketKey: "skill-1|medium|numeric|2",
            correct: false,
            timingMs: 100,
          }),
          attempt({
            attemptId: "partial",
            bucketKey: "skill-1|medium|numeric|2",
            timingQuality: "partial",
            timingMs: 100,
          }),
        ],
        baselines: [baseline()],
      }),
    );
    expect(metrics.efficiency).toHaveLength(1);
    expect(metrics.efficiency[0]?.sampleCount).toBe(1);
  });
});

describe("question quality", () => {
  it("divides confirmed problems by reviewed questions", () => {
    const metrics = computeLearningMetrics(
      facts({
        questionQuality: [
          { questionVersionId: "v1", reviewed: true, confirmedProblem: true },
          { questionVersionId: "v2", reviewed: true, confirmedProblem: false },
          { questionVersionId: "v3", reviewed: true, confirmedProblem: false },
          { questionVersionId: "v3", reviewed: true, confirmedProblem: false },
          { questionVersionId: "v4", reviewed: false, confirmedProblem: false },
        ],
      }),
    );
    expect(metrics.questionQuality).toEqual({
      numerator: 1,
      denominator: 3,
      value: 1 / 3,
    });
  });
});

describe("zero samples", () => {
  it("returns null values instead of zero when there is no evidence", () => {
    const metrics = computeLearningMetrics(facts());
    expect(metrics.confirmedDiagnosis.overall.value).toBeNull();
    expect(metrics.diagnosisCoverage.value).toBeNull();
    expect(metrics.selfCheckSuccess.overall.value).toBeNull();
    expect(metrics.independentNewCorrect.value).toBeNull();
    expect(metrics.independentCoverage.value).toBeNull();
    expect(metrics.delayedReview.completion.value).toBeNull();
    expect(metrics.delayedReview.pass.value).toBeNull();
    expect(metrics.timing.coverage.value).toBeNull();
    expect(metrics.timing.reliable.value).toBeNull();
    expect(metrics.questionQuality.value).toBeNull();
    expect(metrics.efficiency).toEqual([]);
    expect(metrics.hintDependency).toEqual({});
  });
});

describe("group reference", () => {
  it("stays disabled by default", () => {
    expect(computeGroupReference(facts())).toEqual({
      enabled: false,
      available: false,
      studentCount: 0,
      sampleCount: 0,
      maxSamplesPerStudent: 5,
      reasonCodes: ["DISABLED"],
    });
  });

  it("does not let one student's repeated samples pass the gate", () => {
    const groupSamples = Array.from({ length: 100 }, (_, index) => ({
      studentId: "student-1",
      sampleKey: `sample-${index}`,
    }));
    const result = computeGroupReference(
      facts({ groupReferenceEnabled: true, groupSamples }),
    );
    expect(result.studentCount).toBe(1);
    expect(result.sampleCount).toBe(5);
    expect(result.available).toBe(false);
    expect(result.reasonCodes).toEqual([
      "STUDENTS_BELOW_MINIMUM",
      "SAMPLES_BELOW_MINIMUM",
    ]);
  });

  it("opens only after thirty students and one hundred capped samples", () => {
    const groupSamples = Array.from({ length: 30 }, (_, student) =>
      Array.from({ length: 5 }, (_, sample) => ({
        studentId: `student-${student}`,
        sampleKey: `sample-${student}-${sample}`,
      })),
    ).flat();
    const result = computeGroupReference(
      facts({ groupReferenceEnabled: true, groupSamples }),
    );
    expect(result).toMatchObject({
      enabled: true,
      available: true,
      studentCount: 30,
      sampleCount: 150,
      reasonCodes: [],
    });
  });
});
