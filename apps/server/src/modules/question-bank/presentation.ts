import {
  answerPayloadSchema,
  answerSpecSchema,
  presentationCandidateSchema,
  publicQuestionSchema,
  questionPresentationSchema,
  type AnswerPayload,
  type AnswerSpec,
  type PresentationCandidate,
  type PublicQuestion,
  type QuestionPresentation,
  type QuestionType,
} from "../../../../../packages/contracts/src/question-presentation.js";
import { equivalent } from "../learning/verifier.js";
import { inspectStudentText } from "./student-language.js";

export class PresentationValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PresentationValidationError";
  }
}

export type ValidatedQuestion = {
  questionType: QuestionType;
  stem: string;
  presentation: QuestionPresentation;
  answerSpec: AnswerSpec;
  referenceAnswer: string | null;
  rubric: string[];
};

const UNSAFE_EXPRESSION = /process|require|Function|eval|constructor\s*\(|[`$;]|import\s+/i;

export function validateQuestionPresentation(
  candidate: unknown,
  options: { skipLanguage?: boolean } = {},
): ValidatedQuestion {
  const parsed = presentationCandidateSchema.safeParse(candidate);
  if (!parsed.success)
    throw new PresentationValidationError("INVALID_PRESENTATION", "题目结构不合法");
  const value = parsed.data;
  if (
    !options.skipLanguage &&
    inspectStudentText(value.stem).status !== "accepted"
  )
    throw new PresentationValidationError(
      "LANGUAGE",
      "学生可见题干需要简体中文",
    );
  if (!value.presentation || !value.answerSpec)
    throw new PresentationValidationError("MISSING_SPEC", "缺少题目展示或答案规范");
  if (value.questionType === "legacy")
    throw new PresentationValidationError("LEGACY_TYPE", "不能发布未识别的历史题型");
  assertTypeMatch(value);
  assertChoiceIntegrity(value);
  assertBlankIntegrity(value);
  return {
    questionType: value.questionType,
    stem: value.stem,
    presentation: value.presentation,
    answerSpec: value.answerSpec,
    referenceAnswer: value.referenceAnswer,
    rubric: value.rubric,
  };
}

function assertTypeMatch(value: PresentationCandidate) {
  const spec = value.answerSpec;
  const presentation = value.presentation;
  if (!spec || !presentation) return;
  if (value.questionType === "single_choice") {
    if (spec.kind !== "single_choice" || presentation.kind !== "choice" || presentation.multiple)
      throw new PresentationValidationError("TYPE_MISMATCH", "单选题规范不匹配");
  }
  if (value.questionType === "multiple_choice") {
    if (spec.kind !== "multiple_choice" || presentation.kind !== "choice" || !presentation.multiple)
      throw new PresentationValidationError("TYPE_MISMATCH", "多选题规范不匹配");
  }
  if (value.questionType === "fill_blank") {
    if (spec.kind !== "fill_blank" || presentation.kind !== "blank")
      throw new PresentationValidationError("TYPE_MISMATCH", "填空题规范不匹配");
  }
  if (value.questionType === "worked") {
    if (spec.kind !== "worked" || presentation.kind !== "worked")
      throw new PresentationValidationError("TYPE_MISMATCH", "解答题规范不匹配");
  }
}

function assertChoiceIntegrity(value: PresentationCandidate) {
  if (value.presentation?.kind !== "choice" || !value.answerSpec) return;
  const optionIds = new Set(value.presentation.options.map((o) => o.optionId));
  const labels = value.presentation.options.map((o) => o.label.trim());
  if (new Set(labels).size !== labels.length)
    throw new PresentationValidationError("DUPLICATE_OPTION", "干扰项不能重复");
  if (value.answerSpec.kind === "single_choice") {
    if (!optionIds.has(value.answerSpec.correctOptionId))
      throw new PresentationValidationError("MISSING_CORRECT", "正确选项不存在");
    const correct = value.presentation.options.find(
      (o) =>
        value.answerSpec?.kind === "single_choice" &&
        o.optionId === value.answerSpec.correctOptionId,
    );
    if (
      correct &&
      value.presentation.options.some(
        (o) =>
          o.optionId !== correct.optionId &&
          equivalent(o.label, correct.label, "number") === true,
      )
    )
      throw new PresentationValidationError("EQUIVALENT_DISTRACTOR", "干扰项与正确项等价");
  }
  if (value.answerSpec.kind === "multiple_choice") {
    if (value.answerSpec.correctOptionIds.some((id) => !optionIds.has(id)))
      throw new PresentationValidationError("MISSING_CORRECT", "正确选项不存在");
  }
}

function assertBlankIntegrity(value: PresentationCandidate) {
  if (value.presentation?.kind !== "blank" || value.answerSpec?.kind !== "fill_blank")
    return;
  const blankIds = new Set(value.presentation.blanks.map((b) => b.blankId));
  const specIds = value.answerSpec.blanks.map((b) => b.blankId);
  if (specIds.some((id) => !blankIds.has(id)) || blankIds.size !== specIds.length)
    throw new PresentationValidationError("BLANK_MISMATCH", "空位与答案规范不一致");
  for (const blank of value.answerSpec.blanks) {
    if (blank.validation === "expression" && UNSAFE_EXPRESSION.test(blank.answer))
      throw new PresentationValidationError("UNSAFE_EXPRESSION", "表达式不能包含可执行代码");
  }
}

export function assertAnswerMatchesPresentation(
  presentation: QuestionPresentation,
  answer: AnswerPayload,
): void {
  const payload = answerPayloadSchema.parse(answer);
  if (payload.kind === "choice") {
    if (presentation.kind !== "choice")
      throw new PresentationValidationError("ANSWER_KIND", "作答类型不匹配");
    const ids = new Set(presentation.options.map((item) => item.optionId));
    if (payload.optionIds.some((id) => !ids.has(id)))
      throw new PresentationValidationError("UNKNOWN_OPTION", "选项不存在");
    return;
  }
  if (payload.kind === "blanks") {
    if (presentation.kind !== "blank")
      throw new PresentationValidationError("ANSWER_KIND", "作答类型不匹配");
    const ids = new Set(presentation.blanks.map((item) => item.blankId));
    if (payload.values.some((item) => !ids.has(item.blankId)))
      throw new PresentationValidationError("UNKNOWN_BLANK", "空位不存在");
    return;
  }
  if (presentation.kind !== "worked")
    throw new PresentationValidationError("ANSWER_KIND", "作答类型不匹配");
}

export function serializeAnswer(
  question: ValidatedQuestion,
  answer: AnswerPayload,
): string {
  const payload = answerPayloadSchema.parse(answer);
  if (payload.kind === "choice" && question.presentation.kind === "choice") {
    const labels = payload.optionIds.map((id) => {
      const option = question.presentation.kind === "choice"
        ? question.presentation.options.find((item) => item.optionId === id)
        : undefined;
      if (!option) throw new PresentationValidationError("UNKNOWN_OPTION", "选项不存在");
      return option.label;
    });
    return labels.join(",");
  }
  if (payload.kind === "blanks")
    return payload.values.map((item) => item.value).join(";");
  if (payload.kind === "worked") return payload.text;
  throw new PresentationValidationError("ANSWER_KIND", "作答类型不匹配");
}

export function verifyAnswerPayload(
  question: ValidatedQuestion,
  answer: unknown,
): {
  correctness: "correct" | "incorrect" | "uncertain";
  verification: "verified" | "pending";
  method: "exact" | "independent" | "insufficient";
} {
  const payload = answerPayloadSchema.parse(answer);
  if (payload.kind === "choice") {
    if (new Set(payload.optionIds).size !== payload.optionIds.length)
      throw new PresentationValidationError("DUPLICATE_OPTION", "选项不能重复");
    if (question.answerSpec.kind === "single_choice") {
      const ok =
        payload.optionIds.length === 1 &&
        payload.optionIds[0] === question.answerSpec.correctOptionId;
      return {
        correctness: ok ? "correct" : "incorrect",
        verification: "verified",
        method: "exact",
      };
    }
    if (question.answerSpec.kind === "multiple_choice") {
      const expected = [...question.answerSpec.correctOptionIds].sort();
      const actual = [...payload.optionIds].sort();
      const ok =
        expected.length === actual.length &&
        expected.every((id, index) => id === actual[index]);
      return {
        correctness: ok ? "correct" : "incorrect",
        verification: "verified",
        method: "exact",
      };
    }
  }
  if (payload.kind === "blanks" && question.answerSpec.kind === "fill_blank") {
    const byId = new Map(payload.values.map((item) => [item.blankId, item.value]));
    if (byId.size !== question.answerSpec.blanks.length)
      return { correctness: "incorrect", verification: "verified", method: "exact" };
    let all = true;
    for (const blank of question.answerSpec.blanks) {
      const value = byId.get(blank.blankId);
      if (value === undefined) {
        all = false;
        break;
      }
      if (blank.validation === "expression") {
        if (UNSAFE_EXPRESSION.test(value)) {
          all = false;
          break;
        }
        const normalized = value.replace(/\s+/g, "");
        const expected = blank.answer.replace(/\s+/g, "");
        const equivalents = (blank.equivalents ?? []).map((item) =>
          item.replace(/\s+/g, ""),
        );
        if (normalized !== expected && !equivalents.includes(normalized)) all = false;
        continue;
      }
      if (blank.validation === "number") {
        const options = [blank.answer, ...(blank.equivalents ?? [])];
        if (!options.some((item) => equivalent(value, item, "number") === true))
          all = false;
        continue;
      }
      if (value.trim() !== blank.answer.trim()) all = false;
    }
    return {
      correctness: all ? "correct" : "incorrect",
      verification: "verified",
      method: "exact",
    };
  }
  if (payload.kind === "worked" && question.answerSpec.kind === "worked") {
    const text = payload.text.normalize("NFKC");
    const rubric = question.answerSpec.rubric.length
      ? question.answerSpec.rubric
      : question.rubric;
    if (!rubric.length)
      return {
        correctness: "uncertain",
        verification: "pending",
        method: "insufficient",
      };
    const hits = rubric.every((item) => text.includes(item.normalize("NFKC")));
    return {
      correctness: hits ? "correct" : "incorrect",
      verification: "verified",
      method: "exact",
    };
  }
  throw new PresentationValidationError("ANSWER_KIND", "作答类型不匹配");
}

export function toPublicQuestion(version: {
  id: string;
  stem: string;
  questionType: string;
  knowledgePoint: string | null;
  presentation: unknown;
  answerSpec?: unknown;
  referenceAnswer?: string | null;
  rubric?: unknown;
}): PublicQuestion {
  const presentation = questionPresentationSchema.safeParse(version.presentation);
  return publicQuestionSchema.parse({
    questionVersionId: version.id,
    stem: version.stem,
    questionType: version.questionType,
    knowledgePoint: version.knowledgePoint,
    presentation: presentation.success ? presentation.data : null,
  });
}

export function answerSpecFromUnknown(value: unknown): AnswerSpec | null {
  const parsed = answerSpecSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function verifyStructuredAnswer(
  db: { pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> } },
  questionVersionId: string,
  answer: unknown,
): Promise<{
  correctness: "correct" | "incorrect" | "uncertain";
  verification: "verified" | "pending";
  method: "exact" | "independent" | "insufficient";
  serialized: string | null;
}> {
  const row = (
    await db.pool.query(
      `SELECT stem,question_type AS "questionType",presentation,answer_spec AS "answerSpec",
              reference_answer AS "referenceAnswer"
       FROM question_versions WHERE id=$1`,
      [questionVersionId],
    )
  ).rows[0];
  if (!row)
    return {
      correctness: "uncertain",
      verification: "pending",
      method: "insufficient",
      serialized: null,
    };
  const spec = answerSpecSchema.safeParse(row.answerSpec);
  const presentation = questionPresentationSchema.safeParse(row.presentation);
  if (!spec.success || !presentation.success)
    return {
      correctness: "uncertain",
      verification: "pending",
      method: "insufficient",
      serialized: null,
    };
  const validated = validateQuestionPresentation(
    {
      questionType: row.questionType,
      stem: row.stem,
      presentation: presentation.data,
      answerSpec: spec.data,
      referenceAnswer: row.referenceAnswer,
      rubric: spec.data.kind === "worked" ? spec.data.rubric : [],
    },
    { skipLanguage: true },
  );
  const result = verifyAnswerPayload(validated, answer);
  return {
    ...result,
    serialized: serializeAnswer(validated, answerPayloadSchema.parse(answer)),
  };
}
