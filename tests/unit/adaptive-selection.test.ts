import { describe, expect, it } from "vitest";
import type { ProfileDTO } from "../../packages/contracts/src/learning-profile.js";
import type {
  BankCandidate,
  DifficultyBand,
  PracticeGoal,
} from "../../packages/contracts/src/question-bank.js";
import {
  choosePractice,
  targetDifficulty,
  type RecentDecision,
  type ReviewCandidate,
} from "../../apps/server/src/modules/learning-profile/selection-policy.js";

let sequence = 0;
const uuid = () => {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
};

const skillId = "11111111-1111-4111-8111-111111111111";

function profile(overrides: Partial<ProfileDTO> = {}): ProfileDTO {
  return {
    studentId: "22222222-2222-4222-8222-222222222222",
    skillId,
    version: 3,
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

function candidate(
  overrides: Partial<BankCandidate> & { difficulty?: DifficultyBand } = {},
): BankCandidate {
  return {
    entryId: uuid(),
    questionVersionId: uuid(),
    skillId,
    difficulty: "medium",
    complexityBand: 2,
    answerType: "number",
    templateFamily: "family-a",
    matchedCauseCount: 0,
    seenCount: 0,
    ...overrides,
  };
}

function decision(
  goal: PracticeGoal,
  difficulty: DifficultyBand | null,
  questionVersionId = uuid(),
  templateFamily: string | null = null,
): RecentDecision {
  return { goal, difficulty, questionVersionId, templateFamily };
}

function review(overrides: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    questionVersionId: uuid(),
    skillId,
    dueAt: "2026-11-10T09:00:00.000Z",
    sourceQuestionId: uuid(),
    ...overrides,
  };
}

describe("choosePractice", () => {
  it("prioritizes an open diagnosis over due reviews and repair", () => {
    const choice = choosePractice({
      profile: profile(),
      recentDecisions: [],
      candidates: [candidate()],
      dueReviews: [review()],
      openDiagnosis: true,
    });
    expect(choice.goal).toBe("diagnostic");
    expect(choice.status).toBe("selected");
    expect(choice.reasonCodes).toContain("open_diagnosis");
  });

  it("falls back to awaiting diagnosis when the profile is stale", () => {
    const choice = choosePractice({
      profile: profile({ stale: true }),
      recentDecisions: [],
      candidates: [candidate()],
      dueReviews: [review()],
      openDiagnosis: false,
    });
    expect(choice.status).toBe("awaiting_diagnosis");
    expect(choice.candidateId).toBeNull();
    expect(choice.reasonCodes).toContain("profile_stale");
  });

  it("reviews due mistakes before starting new repair practice", () => {
    const due = review({ dueAt: "2026-11-02T09:00:00.000Z" });
    const choice = choosePractice({
      profile: profile(),
      recentDecisions: [],
      candidates: [candidate({ questionVersionId: due.questionVersionId })],
      dueReviews: [review({ dueAt: "2026-11-08T09:00:00.000Z" }), due],
      openDiagnosis: false,
    });
    expect(choice.goal).toBe("review");
    expect(choice.candidateId).toBe(due.questionVersionId);
    expect(choice.reasonCodes).toContain("review_due");
  });

  it("repairs weak consolidation skills and transfers stable ones", () => {
    const weak = choosePractice({
      profile: profile({
        trainingBand: "consolidation",
        recentIndependentCorrect: 2,
        recentDeterminateCount: 5,
      }),
      recentDecisions: [],
      candidates: [candidate()],
      dueReviews: [],
      openDiagnosis: false,
    });
    expect(weak.goal).toBe("repair");
    expect(weak.reasonCodes).toContain("weak_skill");

    const stable = choosePractice({
      profile: profile({
        trainingBand: "consolidation",
        recentIndependentCorrect: 4,
        recentDeterminateCount: 5,
      }),
      recentDecisions: [],
      candidates: [candidate()],
      dueReviews: [],
      openDiagnosis: false,
    });
    expect(stable.goal).toBe("transfer");
    expect(stable.reasonCodes).toContain("stable_skill");
  });

  it("keeps a slow but correct learner in the same band", () => {
    const choice = choosePractice({
      profile: profile({
        trainingBand: "consolidation",
        recentIndependentCorrect: 5,
        recentDeterminateCount: 5,
        efficiency: {
          status: "observed",
          baselineId: uuid(),
          sampleCount: 8,
          medianMs: 60_000,
          timeRatio: 1.8,
          direction: "slower",
          reasonCodes: [],
        },
      }),
      recentDecisions: [],
      candidates: [candidate()],
      dueReviews: [],
      openDiagnosis: false,
    });
    expect(choice.goal).toBe("transfer");
    expect(choice.reasonCodes).toContain("method_optimization");
  });

  it("selects the difficulty with the largest quota deficit", () => {
    const recent = [
      ...Array.from({ length: 12 }, () => decision("repair", "easy")),
      ...Array.from({ length: 7 }, () => decision("repair", "medium")),
    ];
    expect(targetDifficulty("repair", recent)).toBe("challenge");
    expect(
      targetDifficulty("repair", [
        ...Array.from({ length: 12 }, () => decision("repair", "easy")),
        ...Array.from({ length: 7 }, () => decision("repair", "medium")),
        ...Array.from({ length: 1 }, () => decision("repair", "challenge")),
      ]),
    ).toBe("easy");
  });

  it("uses the documented band quotas", () => {
    expect(targetDifficulty("repair", [])).toBe("easy");
    expect(targetDifficulty("consolidation", [])).toBe("medium");
    expect(targetDifficulty("advance", [])).toBe("medium");
    const consolidation = [
      ...Array.from({ length: 6 }, () => decision("repair", "easy")),
      ...Array.from({ length: 10 }, () => decision("repair", "medium")),
      ...Array.from({ length: 3 }, () => decision("repair", "challenge")),
    ];
    expect(targetDifficulty("consolidation", consolidation)).toBe("challenge");
  });

  it("breaks equal deficits in easy, medium, challenge order", () => {
    const tied = [
      ...Array.from({ length: 11 }, () => decision("repair", "easy")),
      ...Array.from({ length: 7 }, () => decision("repair", "medium")),
    ];
    expect(targetDifficulty("repair", tied)).toBe("easy");
  });

  it("relaxes difficulty but keeps the goal when the target band is empty", () => {
    const choice = choosePractice({
      profile: profile(),
      recentDecisions: [],
      candidates: [candidate({ difficulty: "challenge" })],
      dueReviews: [],
      openDiagnosis: false,
    });
    expect(choice.status).toBe("selected");
    expect(choice.goal).toBe("repair");
    expect(choice.difficulty).toBe("challenge");
    expect(choice.reasonCodes).toContain("relaxed_difficulty");
  });

  it("ranks by cause match, novelty, recent family frequency and id", () => {
    const first = candidate({ matchedCauseCount: 1, seenCount: 0 });
    const better = candidate({ matchedCauseCount: 2, seenCount: 0 });
    const choice = choosePractice({
      profile: profile(),
      recentDecisions: [],
      candidates: [first, better],
      dueReviews: [],
      openDiagnosis: false,
    });
    expect(choice.candidateId).toBe(better.questionVersionId);

    const seen = candidate({ seenCount: 1 });
    const fresh = candidate({ seenCount: 0 });
    expect(
      choosePractice({
        profile: profile(),
        recentDecisions: [],
        candidates: [seen, fresh],
        dueReviews: [],
        openDiagnosis: false,
      }).candidateId,
    ).toBe(fresh.questionVersionId);

    const usedFamily = candidate({ templateFamily: "family-a" });
    const freshFamily = candidate({ templateFamily: "family-b" });
    expect(
      choosePractice({
        profile: profile(),
        recentDecisions: [
          decision("repair", "easy", uuid(), "family-a"),
          decision("repair", "easy", uuid(), "family-a"),
        ],
        candidates: [usedFamily, freshFamily],
        dueReviews: [],
        openDiagnosis: false,
      }).candidateId,
    ).toBe(freshFamily.questionVersionId);

    const lowerId = candidate({
      entryId: "00000000-0000-4000-8000-000000000001",
    });
    const higherId = candidate({
      entryId: "00000000-0000-4000-8000-000000000002",
    });
    expect(
      choosePractice({
        profile: profile(),
        recentDecisions: [],
        candidates: [higherId, lowerId],
        dueReviews: [],
        openDiagnosis: false,
      }).candidateId,
    ).toBe(lowerId.questionVersionId);
  });

  it("returns insufficient pool when nothing eligible remains", () => {
    const choice = choosePractice({
      profile: profile(),
      recentDecisions: [],
      candidates: [],
      dueReviews: [],
      openDiagnosis: false,
    });
    expect(choice.status).toBe("insufficient_pool");
    expect(choice.candidateId).toBeNull();
    expect(choice.reasonCodes).toContain("no_candidates");
  });

  it("does not repeat a recent version outside review", () => {
    const used = candidate();
    const choice = choosePractice({
      profile: profile(),
      recentDecisions: [decision("repair", "medium", used.questionVersionId)],
      candidates: [used],
      dueReviews: [],
      openDiagnosis: false,
    });
    expect(choice.status).toBe("insufficient_pool");
    expect(choice.reasonCodes).toContain("repeat_version_excluded");
  });
});
