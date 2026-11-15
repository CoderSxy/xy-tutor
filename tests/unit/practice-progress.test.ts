import { describe, expect, it } from "vitest";
import { computePracticeProgress } from "../../apps/server/src/modules/learning/practice-progress.js";
import type { PracticeItemProgress } from "../../packages/contracts/src/practice-sets.js";

const ID = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

function item(
  index: number,
  overrides: Partial<PracticeItemProgress>,
): PracticeItemProgress {
  return {
    itemId: ID(index),
    submission: "unanswered",
    grading: "none",
    correctness: null,
    mistakeSync: "not_required",
    ...overrides,
  };
}

function verified(index: number): PracticeItemProgress {
  return item(index, {
    submission: "submitted",
    grading: "verified",
    correctness: "correct",
    mistakeSync: "not_required",
  });
}

describe("computePracticeProgress", () => {
  it("marks unverified grading as needs_review and blocks continuation", () => {
    const progressWithUnverified = computePracticeProgress({
      items: [
        verified(1),
        verified(2),
        verified(3),
        verified(4),
        item(5, {
          submission: "submitted",
          grading: "pending",
          correctness: "uncertain",
          mistakeSync: "not_required",
        }),
      ],
    });
    expect(progressWithUnverified.submission).toBe("needs_review");
    expect(progressWithUnverified.canContinue).toBe(false);
  });

  it("does not continue while grading is still queued", () => {
    const progressWithQueued = computePracticeProgress({
      items: [
        verified(1),
        verified(2),
        verified(3),
        verified(4),
        item(5, {
          submission: "submitted",
          grading: "queued",
          correctness: null,
          mistakeSync: "not_required",
        }),
      ],
    });
    expect(progressWithQueued.canContinue).toBe(false);
    expect(progressWithQueued.submission).toBe("grading");
  });

  it("does not continue while a required mistake is unsynced", () => {
    const progressWithUnsyncedMistake = computePracticeProgress({
      items: [
        verified(1),
        verified(2),
        verified(3),
        verified(4),
        item(5, {
          submission: "submitted",
          grading: "verified",
          correctness: "incorrect",
          mistakeSync: "queued",
        }),
      ],
    });
    expect(progressWithUnsyncedMistake.canContinue).toBe(false);
  });

  it("allows continue after four verified items and one explicit skip", () => {
    const progressWithFourVerifiedAndOneSkipped = computePracticeProgress({
      items: [
        verified(1),
        verified(2),
        verified(3),
        verified(4),
        item(5, {
          submission: "skipped",
          grading: "none",
          correctness: null,
          mistakeSync: "not_required",
        }),
      ],
    });
    expect(progressWithFourVerifiedAndOneSkipped.counts.skipped).toBe(1);
    expect(progressWithFourVerifiedAndOneSkipped.canContinue).toBe(true);
    expect(progressWithFourVerifiedAndOneSkipped.submission).toBe("completed");
    expect(progressWithFourVerifiedAndOneSkipped.counts.total).toBe(5);
    expect(progressWithFourVerifiedAndOneSkipped.counts.verified).toBe(4);
  });

  it("does not treat unanswered answered-compat rows as complete", () => {
    const progress = computePracticeProgress({
      items: [
        item(1, { submission: "unanswered", grading: "none" }),
        item(2, { submission: "unanswered", grading: "none" }),
        item(3, { submission: "unanswered", grading: "none" }),
        item(4, { submission: "unanswered", grading: "none" }),
        item(5, { submission: "unanswered", grading: "none" }),
      ],
    });
    expect(progress.submission).toBe("open");
    expect(progress.canContinue).toBe(false);
  });
});
