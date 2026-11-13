import { createHash } from "node:crypto";

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
  answerType: "number";
  fingerprint: string;
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
  return {
    stem: `计算 ${formatFraction(left)} ${op} ${formatFraction(right)} 的值，结果写成最简分数或整数。`,
    answer: formatFraction(result),
    answerType: "number",
    fingerprint: fingerprintOf("rational_arithmetic", version, {
      op,
      a: formatFraction(left),
      b: formatFraction(right),
    }),
  };
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
  return {
    stem: `解方程 ${a}(${inner}) = ${c}，把解写成最简分数或整数。`,
    answer: formatFraction(x),
    answerType: "number",
    fingerprint: fingerprintOf("linear_equation", version, {
      a: a.toString(),
      b: b.toString(),
      c: c.toString(),
    }),
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
