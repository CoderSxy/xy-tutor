import { describe, expect, it } from "vitest";
import {
  allocateExamQuota,
  buildBlueprint,
  selectSlotCandidate,
} from "../../apps/server/src/modules/learning/practice-blueprint.js";
import { TEST_EXAM_PROFILE } from "../../apps/server/src/modules/question-bank/exam-profiles.js";
import type { BankCandidate } from "../../packages/contracts/src/question-bank.js";
import type { ProfileDTO } from "../../packages/contracts/src/learning-profile.js";

function countTypes(
  blueprint: ReturnType<typeof buildBlueprint>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const slot of blueprint.slots)
    counts[slot.questionType] = (counts[slot.questionType] ?? 0) + 1;
  return counts;
}

function candidate(
  overrides: Partial<BankCandidate> = {},
): BankCandidate {
  return {
    entryId: "00000000-0000-4000-8000-000000000001",
    questionVersionId: "00000000-0000-4000-8000-000000000011",
    skillId: "11111111-1111-4111-8111-111111111111",
    difficulty: "medium",
    complexityBand: 2,
    answerType: "single_choice",
    templateFamily: "family-a",
    matchedCauseCount: 1,
    seenCount: 0,
    ...overrides,
  };
}

function profile(overrides: Partial<ProfileDTO> = {}): ProfileDTO {
  return {
    studentId: "22222222-2222-4222-8222-222222222222",
    skillId: "11111111-1111-4111-8111-111111111111",
    version: 1,
    stale: false,
    trainingBand: "repair",
    recentIndependentCorrect: 0,
    recentDeterminateCount: 0,
    efficiency: {
      status: "insufficient_samples",
      baselineId: null,
      sampleCount: 0,
      medianMs: null,
      timeRatio: null,
      direction: null,
      reasonCodes: [],
    },
    evidence: [],
    ...overrides,
  };
}

describe("mixed-v1 blueprint", () => {
  it("uses two single choice, two fill blank and one worked", () => {
    expect(
      countTypes(buildBlueprint({ strategy: "mixed", seed: "fixed" })),
    ).toEqual({ single_choice: 2, fill_blank: 2, worked: 1 });
  });

  it("keeps slot positions 0-4 and replays the same seed", () => {
    const first = buildBlueprint({ strategy: "mixed", seed: "same-seed" });
    const second = buildBlueprint({ strategy: "mixed", seed: "same-seed" });
    expect(first.slots.map((slot) => slot.position)).toEqual([0, 1, 2, 3, 4]);
    expect(first.slots.map((slot) => slot.questionType)).toEqual(
      second.slots.map((slot) => slot.questionType),
    );
    expect(first.policyVersion).toBe("mixed-v1");
  });
});

describe("exam quota", () => {
  it("allocates exactly five seats with largest remainder ties in fixed order", () => {
    const quota = allocateExamQuota(
      { single_choice: 1, fill_blank: 1, worked: 1 },
      5,
    );
    expect(
      quota.single_choice + quota.fill_blank + quota.worked,
    ).toBe(5);
    const tied = allocateExamQuota(
      { single_choice: 1, multiple_choice: 1, fill_blank: 1, worked: 1 },
      5,
    );
    expect(
      tied.single_choice +
        tied.multiple_choice +
        tied.fill_blank +
        tied.worked,
    ).toBe(5);
    expect(tied.single_choice).toBeGreaterThanOrEqual(tied.multiple_choice);
    expect(TEST_EXAM_PROFILE.fixture).toBe(true);
    const exam = buildBlueprint({
      strategy: "exam",
      seed: "exam-seed",
      examProfile: TEST_EXAM_PROFILE,
    });
    expect(exam.slots).toHaveLength(5);
  });

  it("rejects zero or negative weights", () => {
    expect(() => allocateExamQuota({ single_choice: 0, fill_blank: 0, worked: 0 })).toThrow();
    expect(() => allocateExamQuota({ single_choice: -1, fill_blank: 1 })).toThrow();
  });
});

describe("selectSlotCandidate", () => {
  it("excludes private, withdrawn, ineligible and recent exact repeats", () => {
    const slot = buildBlueprint({ strategy: "mixed", seed: "sel" }).slots.find(
      (item) => item.questionType === "single_choice",
    )!;
    const selected = selectSlotCandidate({
      slot,
      scopeSnapshot: { skillIds: ["11111111-1111-4111-8111-111111111111"] },
      profile: profile(),
      candidates: [
        candidate({
          questionVersionId: "00000000-0000-4000-8000-000000000099",
          skillId: "33333333-3333-4333-8333-333333333333",
        }),
        candidate({
          questionVersionId: "00000000-0000-4000-8000-000000000012",
          templateFamily: "withdrawn",
        }),
        candidate({
          questionVersionId: "00000000-0000-4000-8000-000000000013",
        }),
        candidate({
          entryId: "00000000-0000-4000-8000-000000000002",
          questionVersionId: "00000000-0000-4000-8000-000000000014",
          seenCount: 0,
          matchedCauseCount: 3,
        }),
      ],
      recent: [
        {
          goal: "repair",
          difficulty: "medium",
          questionVersionId: "00000000-0000-4000-8000-000000000013",
        },
      ],
      seed: "sel",
      withdrawnTemplateFamilies: ["withdrawn"],
    });
    expect(selected.status).toBe("selected");
    expect(selected.candidateId).toBe(
      "00000000-0000-4000-8000-000000000014",
    );
  });

  it("returns a reason instead of silently swapping types when the pool is empty", () => {
    const slot = buildBlueprint({ strategy: "mixed", seed: "empty" }).slots.find(
      (item) => item.questionType === "worked",
    )!;
    const selected = selectSlotCandidate({
      slot,
      scopeSnapshot: { skillIds: ["11111111-1111-4111-8111-111111111111"] },
      profile: profile(),
      candidates: [
        candidate({ answerType: "single_choice" }),
      ],
      recent: [],
      seed: "empty",
    });
    expect(selected.status).toBe("insufficient_pool");
    expect(selected.reasonCodes).toContain("missing_question_type");
  });
});
