import type { QuestionType } from "../../../../../packages/contracts/src/question-presentation.js";

export type ExamProfile = {
  profileId: string;
  version: string;
  title: string;
  scopeDescription: string;
  sourceNote: string;
  weights: Partial<Record<QuestionType, number>>;
  supportedTypes: QuestionType[];
  fixture?: boolean;
};

export const TEST_EXAM_PROFILE: ExamProfile = {
  profileId: "test-balanced-v1",
  version: "1",
  title: "测试用均衡卷",
  scopeDescription: "仅供自动化测试，不代表真实考试。",
  sourceNote: "fixture",
  weights: { single_choice: 1, fill_blank: 1, worked: 1 },
  supportedTypes: ["single_choice", "fill_blank", "worked"],
  fixture: true,
};

const PROFILES: ExamProfile[] = [TEST_EXAM_PROFILE];

export function listExamProfiles(options: { includeFixtures?: boolean } = {}): ExamProfile[] {
  return PROFILES.filter((profile) => options.includeFixtures || !profile.fixture);
}

export function getExamProfile(
  profileId: string,
  version?: string,
  options: { includeFixtures?: boolean } = {},
): ExamProfile | undefined {
  return listExamProfiles({ includeFixtures: true }).find(
    (profile) =>
      profile.profileId === profileId &&
      (!version || profile.version === version) &&
      (options.includeFixtures || !profile.fixture),
  );
}
