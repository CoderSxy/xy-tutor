import { createHash } from "node:crypto";
import type { QuestionType } from "../../../../../packages/contracts/src/question-presentation.js";
import type { BankCandidate } from "../../../../../packages/contracts/src/question-bank.js";
import type { ProfileDTO } from "../../../../../packages/contracts/src/learning-profile.js";
import type { ExamProfile } from "../question-bank/exam-profiles.js";
import {
  type RecentDecision,
} from "../learning-profile/selection-policy.js";

export const MIXED_POLICY_VERSION = "mixed-v1";
const TYPE_ORDER: QuestionType[] = [
  "single_choice",
  "multiple_choice",
  "fill_blank",
  "worked",
];

export type TypeQuota = Partial<Record<QuestionType, number>> & {
  single_choice?: number;
  fill_blank?: number;
  worked?: number;
  multiple_choice?: number;
};

export type BlueprintSlot = {
  position: number;
  questionType: QuestionType;
};

export type PracticeBlueprint = {
  policyVersion: string;
  strategy: "mixed" | "exam";
  seed: string;
  examProfileId: string | null;
  examProfileVersion: string | null;
  slots: BlueprintSlot[];
};

export function allocateExamQuota(
  weights: Partial<Record<QuestionType, number>>,
  total = 5,
): TypeQuota {
  const supported = TYPE_ORDER.filter((type) => type in weights);
  if (supported.some((type) => (weights[type] ?? 0) < 0))
    throw new Error("INVALID_EXAM_WEIGHTS");
  const sum = supported.reduce((acc, type) => acc + (weights[type] ?? 0), 0);
  if (sum <= 0) throw new Error("INVALID_EXAM_WEIGHTS");
  const raw = supported.map((type) => ({
    type,
    value: ((weights[type] ?? 0) / sum) * total,
  }));
  const quota: TypeQuota = {};
  let used = 0;
  for (const item of raw) {
    const n = Math.floor(item.value);
    quota[item.type] = n;
    used += n;
  }
  const remainders = raw
    .map((item) => ({
      type: item.type,
      remainder: item.value - Math.floor(item.value),
    }))
    .sort((a, b) => {
      if (b.remainder !== a.remainder) return b.remainder - a.remainder;
      return TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
    });
  let index = 0;
  while (used < total && remainders.length) {
    const type = remainders[index % remainders.length]!.type;
    quota[type] = (quota[type] ?? 0) + 1;
    used += 1;
    index += 1;
  }
  return quota;
}

function mixedQuota(): TypeQuota {
  return { single_choice: 2, fill_blank: 2, worked: 1 };
}

function slotsFromQuota(quota: TypeQuota, seed: string): BlueprintSlot[] {
  const types: QuestionType[] = [];
  for (const type of TYPE_ORDER)
    for (let i = 0; i < (quota[type] ?? 0); i += 1) types.push(type);
  const shuffled = seededShuffle(types, seed);
  let arranged = arrangeWithoutTriple(shuffled);
  if (arranged.length > 5) arranged = arranged.slice(0, 5);
  while (arranged.length < 5) arranged.push("fill_blank");
  return arranged.map((questionType, position) => ({ position, questionType }));
}

function seededShuffle<T>(items: T[], seed: string): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const digest = createHash("sha256")
      .update(`${seed}:${i}`)
      .digest();
    const j = digest[0]! % (i + 1);
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

function arrangeWithoutTriple(types: QuestionType[]): QuestionType[] {
  const remaining = [...types];
  const out: QuestionType[] = [];
  while (remaining.length) {
    const index = remaining.findIndex((type, i) => {
      if (out.length < 2) return true;
      return !(out[out.length - 1] === type && out[out.length - 2] === type && i >= 0);
    });
    const pick = index >= 0 ? remaining.splice(index, 1)[0]! : remaining.shift()!;
    out.push(pick);
  }
  return out;
}

export function buildBlueprint(input: {
  strategy: "mixed" | "exam";
  seed: string;
  examProfile?: ExamProfile;
}): PracticeBlueprint {
  if (input.strategy === "exam") {
    if (!input.examProfile) throw new Error("EXAM_PROFILE_REQUIRED");
    const quota = allocateExamQuota(input.examProfile.weights, 5);
    return {
      policyVersion: MIXED_POLICY_VERSION,
      strategy: "exam",
      seed: input.seed,
      examProfileId: input.examProfile.profileId,
      examProfileVersion: input.examProfile.version,
      slots: slotsFromQuota(quota, input.seed),
    };
  }
  return {
    policyVersion: MIXED_POLICY_VERSION,
    strategy: "mixed",
    seed: input.seed,
    examProfileId: null,
    examProfileVersion: null,
    slots: slotsFromQuota(mixedQuota(), input.seed),
  };
}

export type SlotSelection = {
  status: "selected" | "insufficient_pool";
  candidateId: string | null;
  reasonCodes: string[];
};

export function selectSlotCandidate(input: {
  slot: BlueprintSlot;
  scopeSnapshot: { skillIds: string[] };
  profile: ProfileDTO;
  candidates: BankCandidate[];
  recent: RecentDecision[];
  seed: string;
  withdrawnTemplateFamilies?: string[];
}): SlotSelection {
  const allowedSkills = new Set(input.scopeSnapshot.skillIds);
  const used = new Set(
    input.recent
      .map((item) => item.questionVersionId)
      .filter((id): id is string => !!id),
  );
  const withdrawn = new Set(input.withdrawnTemplateFamilies ?? []);
  const eligible = input.candidates.filter((item) => {
    if (!allowedSkills.has(item.skillId)) return false;
    if (used.has(item.questionVersionId)) return false;
    if (item.templateFamily && withdrawn.has(item.templateFamily)) return false;
    return matchesType(item, input.slot.questionType);
  });
  if (eligible.length === 0)
    return {
      status: "insufficient_pool",
      candidateId: null,
      reasonCodes: ["missing_question_type"],
    };
  const ranked = [...eligible].sort(
    (a, b) =>
      b.matchedCauseCount - a.matchedCauseCount ||
      a.seenCount - b.seenCount ||
      a.entryId.localeCompare(b.entryId) ||
      a.questionVersionId.localeCompare(b.questionVersionId),
  );
  return {
    status: "selected",
    candidateId: ranked[0]!.questionVersionId,
    reasonCodes: ["type_quota", `seed:${input.seed}`],
  };
}

function matchesType(candidate: BankCandidate, type: QuestionType): boolean {
  return (
    candidate.answerType === type ||
    (type === "single_choice" && candidate.answerType === "choice") ||
    (type === "fill_blank" && candidate.answerType === "number")
  );
}
