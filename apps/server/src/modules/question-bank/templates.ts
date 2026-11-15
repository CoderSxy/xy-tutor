import { createHash } from "node:crypto";
import type {
  AnswerSpec,
  QuestionPresentation,
  QuestionType,
} from "../../../../../packages/contracts/src/question-presentation.js";

export class TemplateValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TemplateValidationError";
  }
}

export type InstantiatedTemplate = {
  stem: string;
  answer: string;
  answerType: "number" | "choice" | "worked";
  fingerprint: string;
  questionType: QuestionType;
  presentation: QuestionPresentation | null;
  answerSpec: AnswerSpec | null;
};

type Fraction = { n: bigint; d: bigint };

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x || 1n;
}

function fraction(n: bigint, d: bigint): Fraction {
  if (d === 0n)
    throw new TemplateValidationError("ZERO_DENOMINATOR", "分母不能为 0");
  const sign = d < 0n ? -1n : 1n;
  const g = gcd(n, d);
  return { n: (sign * n) / g, d: (sign * d) / g };
}

function formatFraction(value: Fraction): string {
  return value.d === 1n ? value.n.toString() : `${value.n}/${value.d}`;
}

function add(x: Fraction, y: Fraction) {
  return fraction(x.n * y.d + y.n * x.d, x.d * y.d);
}
function subtract(x: Fraction, y: Fraction) {
  return fraction(x.n * y.d - y.n * x.d, x.d * y.d);
}
function multiply(x: Fraction, y: Fraction) {
  return fraction(x.n * y.n, x.d * y.d);
}
function divide(x: Fraction, y: Fraction) {
  if (y.n === 0n)
    throw new TemplateValidationError("DIVISION_BY_ZERO", "除数不能为 0");
  return fraction(x.n * y.d, x.d * y.n);
}

function integerField(
  params: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): bigint {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new TemplateValidationError(
      "PARAM_INVALID",
      `参数 ${key} 必须是整数`,
    );
  if (value < min || value > max)
    throw new TemplateValidationError(
      "PARAM_OUT_OF_RANGE",
      `参数 ${key} 超出允许范围`,
    );
  return BigInt(value);
}

function record(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params))
    throw new TemplateValidationError("PARAM_INVALID", "模板参数格式不正确");
  return params as Record<string, unknown>;
}

function fingerprintOf(
  templateCode: string,
  version: number,
  canonical: unknown,
): string {
  return createHash("sha256")
    .update(`${templateCode}@${version}:${JSON.stringify(canonical)}`)
    .digest("hex");
}

export const TEMPLATE_CODES = [
  "rational_arithmetic",
  "linear_equation",
] as const;
export type TemplateCode = (typeof TEMPLATE_CODES)[number];

const MAX_MAGNITUDE = 100;

function instantiateRationalArithmetic(
  version: number,
  raw: unknown,
): InstantiatedTemplate {
  if (version !== 1)
    throw new TemplateValidationError("TEMPLATE_VERSION", "不支持的模板版本");
  const params = record(raw);
  const op = params.op;
  if (op !== "+" && op !== "-" && op !== "*" && op !== "/")
    throw new TemplateValidationError(
      "PARAM_INVALID",
      "运算符必须是 +、-、* 或 /",
    );
  const a = integerField(params, "a", -MAX_MAGNITUDE, MAX_MAGNITUDE);
  const b = integerField(params, "b", -MAX_MAGNITUDE, MAX_MAGNITUDE);
  const c = integerField(params, "c", -MAX_MAGNITUDE, MAX_MAGNITUDE);
  const d = integerField(params, "d", -MAX_MAGNITUDE, MAX_MAGNITUDE);
  if (b === 0n || d === 0n)
    throw new TemplateValidationError("ZERO_DENOMINATOR", "分母不能为 0");
  const left = fraction(a, b);
  const right = fraction(c, d);
  const result =
    op === "+"
      ? add(left, right)
      : op === "-"
        ? subtract(left, right)
        : op === "*"
          ? multiply(left, right)
          : divide(left, right);
  const answer = formatFraction(result);
  const fingerprint = fingerprintOf("rational_arithmetic", version, {
    op,
    a: formatFraction(left),
    b: formatFraction(right),
    form: params.form ?? "number",
  });
  const stem = `计算 ${formatFraction(left)} ${op} ${formatFraction(right)} 的值，结果写成最简分数或整数。`;
  return withForm(stem, answer, fingerprint, params.form);
}

function instantiateLinearEquation(
  version: number,
  raw: unknown,
): InstantiatedTemplate {
  if (version !== 1)
    throw new TemplateValidationError("TEMPLATE_VERSION", "不支持的模板版本");
  const params = record(raw);
  const a = integerField(params, "a", -20, 20);
  const b = integerField(params, "b", -MAX_MAGNITUDE, MAX_MAGNITUDE);
  const c = integerField(params, "c", -MAX_MAGNITUDE, MAX_MAGNITUDE);
  if (a === 0n)
    throw new TemplateValidationError("ZERO_COEFFICIENT", "一次项系数不能为 0");
  // a(x+b)=c ⇒ x=c/a−b
  const x = subtract(fraction(c, a), fraction(b, 1n));
  const inner =
    b < 0n ? `x - ${-b}` : b > 0n ? `x + ${b}` : "x";
  const answer = formatFraction(x);
  const fingerprint = fingerprintOf("linear_equation", version, {
    a: a.toString(),
    b: b.toString(),
    c: c.toString(),
    form: params.form ?? "number",
  });
  const stem = `解方程 ${a}(${inner}) = ${c}，把解写成最简分数或整数。`;
  return withForm(stem, answer, fingerprint, params.form);
}

function distractors(answer: string): string[] {
  const value = fractionFromAnswer(answer);
  const candidates = [
    formatFraction({ n: -value.n, d: value.d }),
    formatFraction(add(value, fraction(1n, 1n))),
    formatFraction(subtract(value, fraction(1n, 1n))),
    value.n === 0n ? "1" : formatFraction(fraction(value.d, value.n)),
  ];
  const unique: string[] = [];
  for (const item of candidates) {
    if (item === answer) continue;
    if (unique.includes(item)) continue;
    unique.push(item);
    if (unique.length === 3) break;
  }
  while (unique.length < 3) unique.push(`${unique.length + 7}`);
  return unique.slice(0, 3);
}

function fractionFromAnswer(answer: string): Fraction {
  const parts = answer.split("/");
  if (parts.length === 1) return fraction(BigInt(parts[0]!), 1n);
  return fraction(BigInt(parts[0]!), BigInt(parts[1]!));
}

function withForm(
  stem: string,
  answer: string,
  fingerprint: string,
  form: unknown,
): InstantiatedTemplate {
  if (form === "single_choice") {
    const labels = [answer, ...distractors(answer)];
    const options = labels.map((label) => ({
      optionId: `opt-${createHash("sha256").update(label).digest("hex").slice(0, 8)}`,
      label,
    }));
    const seed = Number.parseInt(fingerprint.slice(0, 8), 16);
    options.sort((a, b) => {
      const ha = Number.parseInt(
        createHash("sha256").update(`${seed}:${a.optionId}`).digest("hex").slice(0, 8),
        16,
      );
      const hb = Number.parseInt(
        createHash("sha256").update(`${seed}:${b.optionId}`).digest("hex").slice(0, 8),
        16,
      );
      return ha - hb;
    });
    const correct = options.find((item) => item.label === answer)!;
    return {
      stem: `${stem}请选择正确答案。`,
      answer,
      answerType: "choice",
      fingerprint,
      questionType: "single_choice",
      presentation: { kind: "choice", multiple: false, options },
      answerSpec: { kind: "single_choice", correctOptionId: correct.optionId },
    };
  }
  if (form === "fill_blank") {
    return {
      stem: `${stem}把答案填入空中。`,
      answer,
      answerType: "number",
      fingerprint,
      questionType: "fill_blank",
      presentation: { kind: "blank", blanks: [{ blankId: "result", label: "结果" }] },
      answerSpec: {
        kind: "fill_blank",
        blanks: [{ blankId: "result", validation: "number", answer }],
      },
    };
  }
  if (form === "worked") {
    return {
      stem,
      answer,
      answerType: "worked",
      fingerprint,
      questionType: "worked",
      presentation: {
        kind: "worked",
        requirements: "写出计算过程，并给出最简结果。",
        requiresWorking: true,
      },
      answerSpec: {
        kind: "worked",
        requiresWorking: true,
        rubric: ["计算", answer],
        referenceAnswer: `计算过程略，结果为 ${answer}。`,
        verificationStrategy: "deterministic",
      },
    };
  }
  return {
    stem,
    answer,
    answerType: "number",
    fingerprint,
    questionType: "legacy",
    presentation: null,
    answerSpec: null,
  };
}

export function instantiateTemplate(
  templateCode: string,
  version: number,
  params: unknown,
): InstantiatedTemplate {
  switch (templateCode) {
    case "rational_arithmetic":
      return instantiateRationalArithmetic(version, params);
    case "linear_equation":
      return instantiateLinearEquation(version, params);
    default:
      throw new TemplateValidationError("TEMPLATE_UNKNOWN", "未知模板");
  }
}
