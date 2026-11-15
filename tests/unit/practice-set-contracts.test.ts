import { describe, it, expect } from "vitest";
import {
  practiceModeSchema,
  practiceStrategySchema,
  practiceGenerationSchema,
  practiceSubmissionStateSchema,
  practiceItemProgressSchema,
  practiceSetSchema,
  submitPracticeInputSchema,
  draftInputSchema,
  preferencesPatchSchema,
  continueInputSchema,
} from "../../packages/contracts/src/practice-sets.js";
import {
  questionTypeSchema,
  answerPayloadSchema,
  questionPresentationSchema,
  answerSpecSchema,
  publicQuestionSchema,
  languageStatusSchema,
} from "../../packages/contracts/src/question-presentation.js";
import {
  mistakeOriginCategorySchema,
  mistakeLifecycleSchema,
  mistakePageSchema,
} from "../../packages/contracts/src/mistakes.js";

const itemProgress = {
  itemId: "00000000-0000-4000-8000-000000000001",
  submission: "submitted",
  grading: "verified",
  correctness: "correct",
  mistakeSync: "not_required",
};

describe("practice mode and strategy contracts", () => {
  it("accepts only the confirmed practice modes", () => {
    expect(practiceModeSchema.safeParse("step").success).toBe(true);
    expect(practiceModeSchema.safeParse("batch").success).toBe(true);
    expect(practiceModeSchema.safeParse("exam").success).toBe(false);
    expect(practiceStrategySchema.safeParse("mixed").success).toBe(true);
    expect(practiceStrategySchema.safeParse("adaptive").success).toBe(false);
  });

  it("uses the spec generation and submission state enums", () => {
    for (const value of [
      "awaiting_scope",
      "preparing",
      "ready",
      "insufficient_pool",
      "failed",
    ])
      expect(practiceGenerationSchema.safeParse(value).success).toBe(true);
    expect(practiceGenerationSchema.safeParse("working").success).toBe(false);
    for (const value of ["open", "grading", "needs_review", "completed"])
      expect(practiceSubmissionStateSchema.safeParse(value).success).toBe(true);
    expect(practiceSubmissionStateSchema.safeParse("done").success).toBe(false);
  });
});

describe("question type and answer contracts", () => {
  it("accepts only confirmed question types", () => {
    for (const value of [
      "single_choice",
      "multiple_choice",
      "fill_blank",
      "worked",
      "legacy",
    ])
      expect(questionTypeSchema.safeParse(value).success).toBe(true);
    expect(questionTypeSchema.safeParse("number").success).toBe(false);
  });

  it("rejects empty choice payloads and malformed blanks", () => {
    expect(
      answerPayloadSchema.safeParse({ kind: "choice", optionIds: [] }).success,
    ).toBe(false);
    expect(
      answerPayloadSchema.safeParse({ kind: "choice", optionIds: ["a"] })
        .success,
    ).toBe(true);
    expect(
      answerPayloadSchema.safeParse({
        kind: "blanks",
        values: [{ blankId: "b1", value: "2" }],
      }).success,
    ).toBe(true);
    expect(
      answerPayloadSchema.safeParse({
        kind: "worked",
        text: "先移项再合并同类项",
        attachmentIds: [],
      }).success,
    ).toBe(true);
    expect(answerPayloadSchema.safeParse({ kind: "number", value: 2 }).success).toBe(
      false,
    );
  });

  it("keeps single choice presentation bounded to 2-6 stable options", () => {
    const presentation = {
      kind: "choice",
      multiple: false,
      options: [
        { optionId: "a", label: "2" },
        { optionId: "b", label: "3" },
      ],
    };
    expect(questionPresentationSchema.safeParse(presentation).success).toBe(
      true,
    );
    expect(
      questionPresentationSchema.safeParse({
        ...presentation,
        options: [{ optionId: "a", label: "2" }],
      }).success,
    ).toBe(false);
    expect(
      questionPresentationSchema.safeParse({
        ...presentation,
        options: Array.from({ length: 7 }, (_, i) => ({
          optionId: `o${i}`,
          label: String(i),
        })),
      }).success,
    ).toBe(false);
  });

  it("separates private answer spec from public presentation", () => {
    const spec = {
      kind: "fill_blank",
      blanks: [
        {
          blankId: "b1",
          validation: "number",
          answer: "2",
          equivalents: ["2.0"],
        },
      ],
    };
    expect(answerSpecSchema.safeParse(spec).success).toBe(true);
    const publicQuestion = {
      questionVersionId: "00000000-0000-4000-8000-000000000001",
      stem: "求 1+1 的值",
      questionType: "fill_blank",
      knowledgePoint: null,
      presentation: {
        kind: "blank",
        blanks: [{ blankId: "b1" }],
      },
    };
    expect(publicQuestionSchema.safeParse(publicQuestion).success).toBe(true);
    expect(
      publicQuestionSchema.safeParse({ ...publicQuestion, answerSpec: spec })
        .success,
    ).toBe(false);
    expect(
      publicQuestionSchema.safeParse({
        ...publicQuestion,
        referenceAnswer: "2",
      }).success,
    ).toBe(false);
    for (const value of ["unchecked", "accepted", "repair_required"])
      expect(languageStatusSchema.safeParse(value).success).toBe(true);
  });
});

describe("practice set DTO and input contracts", () => {
  it("parses a complete practice set DTO", () => {
    const dto = {
      id: "00000000-0000-4000-8000-000000000010",
      taskId: "00000000-0000-4000-8000-000000000011",
      version: 1,
      mode: "step",
      strategy: "mixed",
      examProfileId: null,
      generation: "ready",
      submission: "open",
      counts: { total: 5, submitted: 1, skipped: 0, verified: 1, pending: 0 },
      canContinue: false,
      items: [
        {
          slotId: "00000000-0000-4000-8000-000000000020",
          position: 0,
          questionType: "single_choice",
          itemId: null,
          questionVersionId: null,
          stem: null,
          presentation: null,
          progress: { ...itemProgress, submission: "unanswered", grading: "none", correctness: null, mistakeSync: "not_required" },
          reasonCode: "awaiting_generation",
        },
      ],
    };
    expect(practiceSetSchema.safeParse(dto).success).toBe(true);
    expect(
      practiceSetSchema.safeParse({
        ...dto,
        items: [{ ...dto.items[0], position: 5 }],
      }).success,
    ).toBe(false);
  });

  it("requires requestKey and bounded entries for submission", () => {
    const input = {
      requestKey: "req-1",
      expectedVersion: 1,
      entries: [
        {
          itemId: "00000000-0000-4000-8000-000000000001",
          answer: { kind: "choice", optionIds: ["a"] },
        },
      ],
      skippedItemIds: [],
      finalize: true,
    };
    expect(submitPracticeInputSchema.safeParse(input).success).toBe(true);
    expect(
      submitPracticeInputSchema.safeParse({ ...input, requestKey: "" }).success,
    ).toBe(false);
    expect(
      submitPracticeInputSchema.safeParse({
        ...input,
        entries: Array.from({ length: 6 }, () => input.entries[0]),
      }).success,
    ).toBe(false);
  });

  it("validates draft, preferences and continue inputs", () => {
    expect(
      draftInputSchema.safeParse({
        expectedVersion: 1,
        answer: { kind: "worked", text: "步骤", attachmentIds: [] },
      }).success,
    ).toBe(true);
    expect(preferencesPatchSchema.safeParse({ mode: null }).success).toBe(true);
    expect(
      preferencesPatchSchema.safeParse({ mode: "step", strategy: "mixed" })
        .success,
    ).toBe(true);
    expect(
      continueInputSchema.safeParse({ requestKey: "c1", expectedVersion: 1 })
        .success,
    ).toBe(true);
  });

  it("models item progress as independent facts", () => {
    expect(practiceItemProgressSchema.safeParse(itemProgress).success).toBe(
      true,
    );
    expect(
      practiceItemProgressSchema.safeParse({
        ...itemProgress,
        grading: "done",
      }).success,
    ).toBe(false);
    expect(
      practiceItemProgressSchema.safeParse({
        ...itemProgress,
        mistakeSync: "syncronized",
      }).success,
    ).toBe(false);
  });
});

describe("mistake provenance contracts", () => {
  it("accepts the confirmed origins and lifecycle", () => {
    for (const value of ["uploaded", "learning", "unknown"])
      expect(mistakeOriginCategorySchema.safeParse(value).success).toBe(true);
    expect(mistakeOriginCategorySchema.safeParse("shared").success).toBe(false);
    for (const value of ["active", "revoked"])
      expect(mistakeLifecycleSchema.safeParse(value).success).toBe(true);
    expect(mistakeLifecycleSchema.safeParse("mastered").success).toBe(false);
  });

  it("requires origin counts alongside a mistake page", () => {
    const page = {
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      originCounts: { all: 0, uploaded: 0, learning: 0, unknown: 0 },
    };
    expect(mistakePageSchema.safeParse(page).success).toBe(true);
    expect(
      mistakePageSchema.safeParse({ ...page, originCounts: undefined }).success,
    ).toBe(false);
    expect(mistakePageSchema.safeParse({ ...page, pageSize: 51 }).success).toBe(
      false,
    );
  });
});
