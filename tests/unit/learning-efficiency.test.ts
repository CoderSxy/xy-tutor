import { describe, expect, it } from "vitest";
import {
  BASELINE_MAX_SAMPLES,
  BASELINE_POLICY_VERSION,
  observeEfficiency,
  type EfficiencySample,
} from "../../apps/server/src/modules/learning-profile/efficiency.js";

const STUDENT = "11111111-1111-4111-8111-111111111111";
const SKILL = "22222222-2222-4222-8222-222222222222";

let seq = 0;
function versionId(n: number): string {
  return `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
}

function sample(overrides: Partial<EfficiencySample> = {}): EfficiencySample {
  seq += 1;
  return {
    id: `44444444-4444-4444-8444-${String(seq).padStart(12, "0")}`,
    studentId: STUDENT,
    skillId: SKILL,
    questionVersionId: versionId(seq),
    difficultyBand: "easy",
    answerType: "number",
    complexityBand: 1,
    templateFamily: "rational_arithmetic",
    attemptAt: new Date(
      `2026-03-${String(10 + seq).padStart(2, "0")}T09:00:00Z`,
    ),
    firstAttemptMs: 60_000,
    quality: "reliable",
    verification: "verified",
    correctness: "correct",
    hintDependency: "none",
    exposure: "none",
    firstEncounter: true,
    redo: false,
    ...overrides,
  };
}

function current(overrides: Partial<EfficiencySample> = {}): EfficiencySample {
  return sample({
    attemptAt: new Date("2026-03-31T09:00:00Z"),
    ...overrides,
  });
}

function fiveSamples(): EfficiencySample[] {
  return [
    sample({
      questionVersionId: versionId(101),
      templateFamily: "rational_arithmetic",
      attemptAt: new Date("2026-03-11T09:00:00Z"),
      firstAttemptMs: 40_000,
    }),
    sample({
      questionVersionId: versionId(102),
      templateFamily: "linear_equation",
      attemptAt: new Date("2026-03-13T09:00:00Z"),
      firstAttemptMs: 50_000,
    }),
    sample({
      questionVersionId: versionId(103),
      templateFamily: "rational_arithmetic",
      attemptAt: new Date("2026-03-16T09:00:00Z"),
      firstAttemptMs: 60_000,
    }),
    sample({
      questionVersionId: versionId(104),
      templateFamily: "linear_equation",
      attemptAt: new Date("2026-03-20T09:00:00Z"),
      firstAttemptMs: 70_000,
    }),
    sample({
      questionVersionId: versionId(105),
      templateFamily: "rational_arithmetic",
      attemptAt: new Date("2026-03-24T09:00:00Z"),
      firstAttemptMs: 80_000,
    }),
  ];
}

describe("observeEfficiency", () => {
  it("四样本不足，不给方向", () => {
    const samples = fiveSamples().slice(0, 4);
    const observation = observeEfficiency(
      current({ firstAttemptMs: 60_000 }),
      samples,
    );
    expect(observation.status).toBe("insufficient_samples");
    expect(observation.sampleCount).toBe(4);
    expect(observation.medianMs).toBeNull();
    expect(observation.timeRatio).toBeNull();
    expect(observation.direction).toBeNull();
    expect(observation.reasonCodes).toContain("SAMPLES_BELOW_MINIMUM");
    expect(observation.baselineId).toBeNull();
  });

  it("五个不同版本但同日仍不足", () => {
    const samples = fiveSamples().map((item) => ({
      ...item,
      attemptAt: new Date("2026-03-11T09:00:00Z"),
    }));
    const observation = observeEfficiency(current(), samples);
    expect(observation.status).toBe("insufficient_samples");
    expect(observation.sampleCount).toBe(5);
    expect(observation.reasonCodes).toContain("DATES_BELOW_MINIMUM");
    expect(observation.reasonCodes).not.toContain("FAMILIES_BELOW_MINIMUM");
  });

  it("五个不同版本但同模板家族仍不足", () => {
    const samples = fiveSamples().map((item) => ({
      ...item,
      templateFamily: "rational_arithmetic",
    }));
    const observation = observeEfficiency(current(), samples);
    expect(observation.status).toBe("insufficient_samples");
    expect(observation.reasonCodes).toContain("FAMILIES_BELOW_MINIMUM");
    expect(observation.reasonCodes).not.toContain("DATES_BELOW_MINIMUM");
  });

  it("五个样本但只有四个不同版本仍不足", () => {
    const samples = fiveSamples();
    samples[4] = {
      ...samples[4]!,
      questionVersionId: samples[3]!.questionVersionId,
    };
    const observation = observeEfficiency(current(), samples);
    expect(observation.status).toBe("insufficient_samples");
    expect(observation.reasonCodes).toContain("VERSIONS_BELOW_MINIMUM");
  });

  it("跨两日两家族时计算中位数并给出方向", () => {
    const observation = observeEfficiency(
      current({ firstAttemptMs: 60_000 }),
      fiveSamples(),
    );
    expect(observation.status).toBe("observed");
    expect(observation.sampleCount).toBe(5);
    expect(observation.medianMs).toBe(60_000);
    expect(observation.timeRatio).toBe(1);
    expect(observation.direction).toBe("comparable");
    expect(observation.reasonCodes).toEqual([]);
  });

  it("0、缺计时、partial、有提示、重做、未来数据都不进入基线", () => {
    const base = fiveSamples();
    const noise: EfficiencySample[] = [
      sample({ questionVersionId: versionId(201), firstAttemptMs: 0 }),
      sample({ questionVersionId: versionId(202), firstAttemptMs: null }),
      sample({ questionVersionId: versionId(203), quality: "missing" }),
      sample({ questionVersionId: versionId(204), quality: "partial" }),
      sample({ questionVersionId: versionId(205), quality: "unusable" }),
      sample({ questionVersionId: versionId(206), hintDependency: "guided" }),
      sample({
        questionVersionId: versionId(207),
        exposure: "solution_exposed",
      }),
      sample({ questionVersionId: versionId(208), redo: true }),
      sample({ questionVersionId: versionId(209), firstEncounter: false }),
      sample({ questionVersionId: versionId(210), correctness: "incorrect" }),
      sample({ questionVersionId: versionId(211), verification: "pending" }),
      sample({
        questionVersionId: versionId(212),
        studentId: "55555555-5555-4555-8555-555555555555",
      }),
      sample({
        questionVersionId: versionId(213),
        skillId: "66666666-6666-4666-8666-666666666666",
      }),
      sample({
        questionVersionId: versionId(214),
        difficultyBand: "challenge",
      }),
      sample({ questionVersionId: versionId(215), answerType: "choice" }),
      sample({ questionVersionId: versionId(216), complexityBand: 3 }),
      sample({
        questionVersionId: versionId(217),
        attemptAt: new Date("2026-04-10T09:00:00Z"),
        firstAttemptMs: 1_000,
      }),
      sample({
        questionVersionId: versionId(218),
        attemptAt: new Date("2026-01-01T09:00:00Z"),
        firstAttemptMs: 1_000,
      }),
    ];
    const observation = observeEfficiency(current({ firstAttemptMs: 60_000 }), [
      ...base,
      ...noise,
    ]);
    expect(observation.status).toBe("observed");
    expect(observation.sampleCount).toBe(5);
    expect(observation.medianMs).toBe(60_000);
  });

  it("基线最多取最近二十个样本", () => {
    const samples = Array.from({ length: 25 }, (_, index) =>
      sample({
        questionVersionId: versionId(300 + index),
        templateFamily:
          index % 2 === 0 ? "rational_arithmetic" : "linear_equation",
        attemptAt: new Date("2026-03-01T09:00:00Z"),
        firstAttemptMs: 10_000 + index * 1_000,
      }),
    );
    // 日期一样会不足，补两个日期以进入 observed，验证截断只看数量。
    samples.forEach((item, index) => {
      item.attemptAt = new Date(
        `2026-03-${String(1 + (index % 2) * 15).padStart(2, "0")}T09:00:00Z`,
      );
    });
    const observation = observeEfficiency(current(), samples);
    expect(observation.sampleCount).toBe(BASELINE_MAX_SAMPLES);
    expect(observation.status).toBe("observed");
  });

  it("0.75 与 1.5 边界都算接近基线", () => {
    const baseline = fiveSamples();
    expect(
      observeEfficiency(current({ firstAttemptMs: 45_000 }), baseline)
        .direction,
    ).toBe("comparable");
    expect(
      observeEfficiency(current({ firstAttemptMs: 90_000 }), baseline)
        .direction,
    ).toBe("comparable");
    expect(
      observeEfficiency(current({ firstAttemptMs: 44_000 }), baseline)
        .direction,
    ).toBe("faster");
    expect(
      observeEfficiency(current({ firstAttemptMs: 91_000 }), baseline)
        .direction,
    ).toBe("slower");
  });

  it("当前样本不能进入自身基线", () => {
    const currentSample = current({ firstAttemptMs: 1_000 });
    const samples = [...fiveSamples(), currentSample];
    const observation = observeEfficiency(currentSample, samples);
    expect(observation.sampleCount).toBe(5);
    expect(observation.medianMs).toBe(60_000);
    expect(observation.timeRatio).toBeCloseTo(0.0167, 3);
  });

  it("当前作答计时不可靠时标记 ineligible", () => {
    const baseline = fiveSamples();
    for (const overrides of [
      { quality: "partial" as const },
      { firstAttemptMs: 0 },
      { firstAttemptMs: null },
      { hintDependency: "guided" as const },
      { exposure: "solution_exposed" as const },
      { redo: true },
      { firstEncounter: false },
    ]) {
      const observation = observeEfficiency(current(overrides), baseline);
      expect(observation.status).toBe("ineligible");
      expect(observation.direction).toBeNull();
      expect(observation.reasonCodes).toContain("CURRENT_SAMPLE_INELIGIBLE");
    }
  });

  it("暴露策略版本", () => {
    expect(BASELINE_POLICY_VERSION).toBe("efficiency-v1");
  });
});

// Regression: a fast incorrect or unverified answer cannot establish efficiency.
it.each([
  { correctness: "incorrect", verification: "verified" },
  { correctness: "correct", verification: "pending" },
])("rejects current efficiency sample %j", (flags) => {
  const observation = observeEfficiency(
    current({ ...flags, firstAttemptMs: 1_000 }),
    fiveSamples(),
  );
  expect(observation.status).toBe("ineligible");
  expect(observation.direction).toBeNull();
});
