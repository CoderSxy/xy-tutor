import type { ProfileDTO } from "../../../../../packages/contracts/src/learning-profile.js";
import type {
  BankCandidate,
  DifficultyBand,
  PracticeGoal,
} from "../../../../../packages/contracts/src/question-bank.js";

export const SELECTION_POLICY_VERSION = "adaptive-selection-v1";

export type RecentDecision = {
  goal: PracticeGoal;
  difficulty: DifficultyBand | null;
  questionVersionId: string | null;
  templateFamily?: string | null;
};

export type ReviewCandidate = {
  questionVersionId: string;
  skillId: string;
  dueAt: string;
  sourceQuestionId: string;
};

export type SelectionContext = {
  profile: ProfileDTO;
  recentDecisions: RecentDecision[];
  candidates: BankCandidate[];
  dueReviews: ReviewCandidate[];
  openDiagnosis: boolean;
};

export type SelectionChoice = {
  status: "selected" | "insufficient_pool" | "awaiting_diagnosis";
  goal: PracticeGoal;
  difficulty: DifficultyBand | null;
  candidateId: string | null;
  reasonCodes: string[];
};

const DIFFICULTY_ORDER: DifficultyBand[] = ["easy", "medium", "challenge"];

const QUOTAS: Record<
  "repair" | "consolidation" | "advance",
  Record<DifficultyBand, number>
> = {
  repair: { easy: 60, medium: 35, challenge: 5 },
  consolidation: { easy: 30, medium: 50, challenge: 20 },
  advance: { easy: 15, medium: 50, challenge: 35 },
};

const WINDOW = 20;

export function targetDifficulty(
  band: "repair" | "consolidation" | "advance",
  recentDecisions: RecentDecision[],
): DifficultyBand {
  const recent = recentDecisions.slice(-(WINDOW - 1));
  const counts: Record<DifficultyBand, number> = {
    easy: 0,
    medium: 0,
    challenge: 0,
  };
  for (const item of recent)
    if (item.difficulty) counts[item.difficulty] += 1;
  const quota = QUOTAS[band];
  let selected: DifficultyBand = "easy";
  let deficit = Number.NEGATIVE_INFINITY;
  for (const difficulty of DIFFICULTY_ORDER) {
    const expected = Math.round((quota[difficulty] / 100) * WINDOW);
    const current = expected - counts[difficulty];
    if (current > deficit) {
      deficit = current;
      selected = difficulty;
    }
  }
  return selected;
}

export function goalFor(
  profile: ProfileDTO,
  openDiagnosis: boolean,
  dueReviews: ReviewCandidate[],
): { goal: PracticeGoal; reasonCodes: string[] } {
  if (openDiagnosis) return { goal: "diagnostic", reasonCodes: ["open_diagnosis"] };
  if (dueReviews.length > 0) return { goal: "review", reasonCodes: ["review_due"] };
  if (profile.trainingBand === "repair")
    return { goal: "repair", reasonCodes: ["band_repair"] };
  const weak =
    profile.recentDeterminateCount > 0 &&
    profile.recentIndependentCorrect * 2 <= profile.recentDeterminateCount;
  if (weak) return { goal: "repair", reasonCodes: ["weak_skill"] };
  return { goal: "transfer", reasonCodes: ["stable_skill"] };
}

function rankCandidates(
  candidates: BankCandidate[],
  recentDecisions: RecentDecision[],
): BankCandidate[] {
  const families = new Map<string, number>();
  for (const item of recentDecisions.slice(-5))
    if (item.templateFamily)
      families.set(
        item.templateFamily,
        (families.get(item.templateFamily) ?? 0) + 1,
      );
  return [...candidates].sort(
    (a, b) =>
      b.matchedCauseCount - a.matchedCauseCount ||
      a.seenCount - b.seenCount ||
      (families.get(a.templateFamily ?? "") ?? 0) -
        (families.get(b.templateFamily ?? "") ?? 0) ||
      a.entryId.localeCompare(b.entryId) ||
      a.questionVersionId.localeCompare(b.questionVersionId),
  );
}

function chooseReview(
  dueReviews: ReviewCandidate[],
  candidates: BankCandidate[],
): ReviewCandidate {
  const versions = new Set(candidates.map((item) => item.questionVersionId));
  return [...dueReviews].sort((a, b) => {
    const preferVariant =
      Number(versions.has(b.questionVersionId)) -
      Number(versions.has(a.questionVersionId));
    if (preferVariant !== 0) return preferVariant;
    return (
      a.dueAt.localeCompare(b.dueAt) ||
      a.questionVersionId.localeCompare(b.questionVersionId)
    );
  })[0]!;
}

export function choosePractice(context: SelectionContext): SelectionChoice {
  const { profile, recentDecisions, candidates, dueReviews, openDiagnosis } =
    context;
  const { goal, reasonCodes } = goalFor(profile, openDiagnosis, dueReviews);
  const methodOptimization =
    profile.efficiency.status === "observed" &&
    profile.efficiency.direction === "slower";
  if (methodOptimization) reasonCodes.push("method_optimization");

  if (profile.stale)
    return {
      status: "awaiting_diagnosis",
      goal,
      difficulty: null,
      candidateId: null,
      reasonCodes: [...reasonCodes, "profile_stale"],
    };

  if (goal === "review") {
    const chosen = chooseReview(dueReviews, candidates);
    const match = candidates.find(
      (item) => item.questionVersionId === chosen.questionVersionId,
    );
    return {
      status: "selected",
      goal,
      difficulty: match?.difficulty ?? null,
      candidateId: chosen.questionVersionId,
      reasonCodes,
    };
  }

  const used = new Set(
    recentDecisions
      .map((item) => item.questionVersionId)
      .filter((id): id is string => !!id),
  );
  const excludedRepeat = candidates.some((item) =>
    used.has(item.questionVersionId),
  );
  const eligible = candidates.filter(
    (item) => !used.has(item.questionVersionId),
  );
  if (eligible.length === 0)
    return {
      status: "insufficient_pool",
      goal,
      difficulty: null,
      candidateId: null,
      reasonCodes: [
        ...reasonCodes,
        "no_candidates",
        ...(excludedRepeat ? ["repeat_version_excluded"] : []),
      ],
    };

  const target = targetDifficulty(profile.trainingBand, recentDecisions);
  let pool = eligible.filter((item) => item.difficulty === target);
  const relaxed = pool.length === 0;
  if (relaxed) pool = eligible;
  const ranked = rankCandidates(pool, recentDecisions);
  return {
    status: "selected",
    goal,
    difficulty: ranked[0]!.difficulty,
    candidateId: ranked[0]!.questionVersionId,
    reasonCodes: [
      ...reasonCodes,
      ...(relaxed ? ["relaxed_difficulty"] : []),
    ],
  };
}
