import { it, expect } from "vitest";
import { decideTransition } from "../../apps/server/src/modules/learning/state-rules.js";
const base = {
  state: "pending_correction" as const,
  correctness: "correct" as const,
  verification: "verified" as const,
  hintDependency: "guided" as const,
  practiceRole: "original" as const,
  variantVerified: false,
  consolidatedAt: null,
  lastConsolidatedQuestionId: null,
  questionId: "original",
};
it("records guided original success as corrected only", () =>
  expect(
    decideTransition(base, new Date("2026-11-08T00:00:00Z")),
  ).toMatchObject({ to: "corrected_pending_practice", changed: true }));
it("requires independent verified variation and a new delayed question for mastery", () => {
  const v = {
    ...base,
    state: "corrected_pending_practice" as const,
    practiceRole: "variant" as const,
    variantVerified: true,
    hintDependency: "none" as const,
    questionId: "variant-1",
  };
  expect(decideTransition(v, new Date("2026-11-08T00:00:00Z"))).toMatchObject({
    to: "consolidated_pending_review",
  });
  const review = {
    ...v,
    state: "consolidated_pending_review" as const,
    consolidatedAt: new Date("2026-11-08T00:00:00Z"),
    lastConsolidatedQuestionId: "variant-1",
    questionId: "variant-2",
  };
  expect(
    decideTransition(review, new Date("2026-11-08T23:59:59Z")).changed,
  ).toBe(false);
  expect(decideTransition(review, new Date("2026-11-09T00:00:00Z")).to).toBe(
    "mastered",
  );
  expect(
    decideTransition(
      { ...review, questionId: "variant-1" },
      new Date("2026-11-10T00:00:00Z"),
    ).changed,
  ).toBe(false);
});
it("does not move on uncertainty and reactivates a mastered mistake on verified failure", () => {
  expect(
    decideTransition({ ...base, correctness: "uncertain" }, new Date()).changed,
  ).toBe(false);
  expect(
    decideTransition(
      { ...base, state: "mastered", correctness: "incorrect" },
      new Date(),
    ).to,
  ).toBe("corrected_pending_practice");
});
it("keeps a newly recorded wrong answer pending correction", () => {
  expect(
    decideTransition({ ...base, correctness: "incorrect" }, new Date()).to,
  ).toBe("pending_correction");
});
