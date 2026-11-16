import { describe, expect, it } from "vitest";
import {
  serializeAnswer,
  toPublicQuestion,
  validateQuestionPresentation,
  verifyAnswerPayload,
} from "../../apps/server/src/modules/question-bank/presentation.js";
import { inspectStudentText } from "../../apps/server/src/modules/question-bank/student-language.js";

const singleChoice = {
  questionType: "single_choice" as const,
  stem: "1+1 等于多少？",
  presentation: {
    kind: "choice" as const,
    multiple: false,
    options: [
      { optionId: "opt-a", label: "1" },
      { optionId: "opt-b", label: "2" },
      { optionId: "opt-c", label: "3" },
      { optionId: "opt-d", label: "0" },
    ],
  },
  answerSpec: { kind: "single_choice" as const, correctOptionId: "opt-b" },
  referenceAnswer: "2",
  rubric: [],
};

describe("validateQuestionPresentation", () => {
  it("accepts a single choice with one stable correct option", () => {
    const validated = validateQuestionPresentation(singleChoice);
    expect(validated.questionType).toBe("single_choice");
    expect(validated.answerSpec).toEqual({
      kind: "single_choice",
      correctOptionId: "opt-b",
    });
    expect(validated.presentation?.kind).toBe("choice");
    expect(
      validated.presentation?.kind === "choice"
        ? new Set(validated.presentation.options.map((o) => o.optionId)).size
        : 0,
    ).toBe(4);
  });

  it("rejects a single choice with two correct options or missing options", () => {
    expect(() =>
      validateQuestionPresentation({
        ...singleChoice,
        answerSpec: {
          kind: "multiple_choice",
          correctOptionIds: ["opt-b", "opt-c"],
        },
      }),
    ).toThrow();
    expect(() =>
      validateQuestionPresentation({
        ...singleChoice,
        presentation: {
          kind: "choice",
          multiple: false,
          options: [{ optionId: "opt-a", label: "1" }],
        },
      }),
    ).toThrow();
  });

  it("rejects a language repair that changes the mathematical condition", () => {
    expect(() =>
      validateQuestionPresentation({
        ...singleChoice,
        stem: "Find the period of y = sin x. This option shifts the graph.",
      }),
    ).toThrow(/LANGUAGE|中文|ENGLISH/);
  });
});

describe("choice and blank verification", () => {
  it("treats multiple-choice order as irrelevant and duplicate ids as invalid", () => {
    const multi = validateQuestionPresentation({
      questionType: "multiple_choice",
      stem: "选出所有偶数。",
      presentation: {
        kind: "choice",
        multiple: true,
        options: [
          { optionId: "opt-a", label: "1" },
          { optionId: "opt-b", label: "2" },
          { optionId: "opt-c", label: "4" },
          { optionId: "opt-d", label: "5" },
        ],
      },
      answerSpec: {
        kind: "multiple_choice",
        correctOptionIds: ["opt-b", "opt-c"],
      },
      referenceAnswer: "2,4",
      rubric: [],
    });
    expect(
      verifyAnswerPayload(multi, {
        kind: "choice",
        optionIds: ["opt-c", "opt-b"],
      }).correctness,
    ).toBe("correct");
    expect(
      verifyAnswerPayload(multi, { kind: "choice", optionIds: ["opt-b"] })
        .correctness,
    ).toBe("incorrect");
    expect(() =>
      verifyAnswerPayload(multi, {
        kind: "choice",
        optionIds: ["opt-b", "opt-b"],
      }),
    ).toThrow();
  });

  it("matches fill-blank values by blank id and fraction equivalence", () => {
    const blank = validateQuestionPresentation({
      questionType: "fill_blank",
      stem: "计算 1/2 + 1/2。",
      presentation: {
        kind: "blank",
        blanks: [
          { blankId: "b1", label: "结果" },
          { blankId: "b2", label: "验算" },
        ],
      },
      answerSpec: {
        kind: "fill_blank",
        blanks: [
          { blankId: "b1", validation: "number", answer: "1" },
          {
            blankId: "b2",
            validation: "number",
            answer: "1/2",
            equivalents: ["0.5"],
          },
        ],
      },
      referenceAnswer: "1;1/2",
      rubric: [],
    });
    expect(
      verifyAnswerPayload(blank, {
        kind: "blanks",
        values: [
          { blankId: "b2", value: "0.5" },
          { blankId: "b1", value: "2/2" },
        ],
      }).correctness,
    ).toBe("correct");
    expect(
      verifyAnswerPayload(blank, {
        kind: "blanks",
        values: [{ blankId: "b1", value: "1" }],
      }).correctness,
    ).toBe("incorrect");
  });

  it("does not execute JavaScript in expression blanks", () => {
    const blank = validateQuestionPresentation({
      questionType: "fill_blank",
      stem: "化简 2x。",
      presentation: { kind: "blank", blanks: [{ blankId: "e1" }] },
      answerSpec: {
        kind: "fill_blank",
        blanks: [{ blankId: "e1", validation: "expression", answer: "2x" }],
      },
      referenceAnswer: "2x",
      rubric: [],
    });
    const result = verifyAnswerPayload(blank, {
      kind: "blanks",
      values: [
        {
          blankId: "e1",
          value: "process.exit(1); this.constructor.constructor('return 2')()",
        },
      ],
    });
    expect(result.correctness).not.toBe("correct");
    expect(result.verification).not.toBeUndefined();
  });
});

describe("worked answers and public DTO stripping", () => {
  it.each(["两边除以2，得x+1=3，所以x=2", "去括号 x=2", ""])(
    "leaves worked evidence %s for independent validation",
    (text) => {
      const worked = validateQuestionPresentation({
        questionType: "worked",
        stem: "解方程 2(x+1)=6，写出步骤。",
        presentation: {
          kind: "worked",
          requirements: "写出关键步骤和最终结果",
          requiresWorking: true,
        },
        answerSpec: {
          kind: "worked",
          requiresWorking: true,
          rubric: ["去括号", "x=2"],
          referenceAnswer: "先去括号得 2x+2=6，再移项得 2x=4，所以 x=2。",
          verificationStrategy: "deterministic",
        },
        referenceAnswer: "先去括号得 2x+2=6，再移项得 2x=4，所以 x=2。",
        rubric: ["去括号", "x=2"],
      });
      expect(
        verifyAnswerPayload(worked, {
          kind: "worked",
          text,
          attachmentIds: [],
        }),
      ).toEqual({
        correctness: "uncertain",
        verification: "pending",
        method: "insufficient",
      });
    },
  );

  it("omits answerSpec, rubric and referenceAnswer from the public JSON", () => {
    const validated = validateQuestionPresentation(singleChoice);
    const publicQuestion = toPublicQuestion({
      id: "00000000-0000-4000-8000-000000000001",
      stem: validated.stem,
      questionType: validated.questionType,
      knowledgePoint: "有理数",
      presentation: validated.presentation,
      answerSpec: validated.answerSpec,
      referenceAnswer: "secret-answer",
      rubric: ["secret-rubric"],
    });
    const json = JSON.stringify(publicQuestion);
    expect(json).not.toContain("answerSpec");
    expect(json).not.toContain("rubric");
    expect(json).not.toContain("referenceAnswer");
    expect(json).not.toContain("secret-answer");
    expect(json).not.toContain("secret-rubric");
    expect(
      serializeAnswer(validated, { kind: "choice", optionIds: ["opt-b"] }),
    ).toBe("2");
    expect(inspectStudentText(validated.stem).status).toBe("accepted");
  });
});
