export type Correctness = "correct" | "incorrect" | "uncertain";
export type VerificationInput = {
  stemConfirmed: boolean;
  referenceVerified: boolean;
  answerType: "number" | "choice" | "worked" | "open";
  requiresWorking: boolean;
  answer: string;
  referenceAnswer?: string;
  candidateCorrectness: Correctness;
  citationsValid: boolean;
  hasImageEvidence?: boolean;
  independent?: {
    correctness: Correctness;
    evidenceSufficient: boolean;
    criteriaSatisfied: boolean;
  };
};
export type VerificationResult = {
  correctness: Correctness;
  verification: "verified" | "pending";
  method: "exact" | "independent" | "insufficient";
  verifierVersion: "assessment-v1";
};
export function rational(value: string): [bigint, bigint] | undefined {
  const v = value.normalize("NFKC").trim();
  if (v.length > 100) return;
  const fraction = v.match(/^([+-]?\d{1,40})\s*\/\s*([+-]?\d{1,40})$/);
  if (fraction) {
    const a = BigInt(fraction[1]!),
      b = BigInt(fraction[2]!);
    return b === 0n ? undefined : [a, b];
  }
  const decimal = v.match(/^([+-]?)(\d{1,40})(?:\.(\d{1,40}))?$/);
  if (!decimal) return;
  const digits = decimal[3] ?? "";
  const denominator = 10n ** BigInt(digits.length);
  return [
    (decimal[1] === "-" ? -1n : 1n) *
      (BigInt(decimal[2]!) * denominator + BigInt(digits || "0")),
    denominator,
  ];
}
export function equivalent(
  a: string,
  b: string,
  type: "number" | "choice",
): boolean | undefined {
  if (type === "number") {
    const x = rational(a),
      y = rational(b);
    if (!x || !y) return;
    return x[0] * y[1] === y[0] * x[1];
  }
  const normalize = (s: string) => {
    const v = s
      .normalize("NFKC")
      .trim()
      .toUpperCase()
      .replace(/[\s,、]/g, "");
    return /^[A-D]+$/.test(v) ? [...new Set(v)].sort().join("") : undefined;
  };
  const x = normalize(a),
    y = normalize(b);
  return x && y ? x === y : undefined;
}
export class AssessmentVerifier {
  async verify(v: VerificationInput): Promise<VerificationResult> {
    const pending: VerificationResult = {
      correctness: "uncertain",
      verification: "pending",
      method: "insufficient",
      verifierVersion: "assessment-v1",
    };
    if (
      !v.stemConfirmed ||
      !v.referenceVerified ||
      !v.citationsValid ||
      !v.referenceAnswer ||
      (!v.hasImageEvidence && v.answerType === "open")
    )
      return pending;
    if (
      !v.hasImageEvidence &&
      !v.requiresWorking &&
      (v.answerType === "number" || v.answerType === "choice")
    ) {
      const same = equivalent(v.answer, v.referenceAnswer, v.answerType);
      if (same !== undefined)
        return {
          ...pending,
          correctness: same ? "correct" : "incorrect",
          verification: "verified",
          method: "exact",
        };
    }
    const other = v.independent;
    if (
      other?.evidenceSufficient &&
      other.correctness !== "uncertain" &&
      other.correctness === v.candidateCorrectness &&
      (other.correctness !== "correct" || other.criteriaSatisfied)
    )
      return {
        ...pending,
        correctness: other.correctness,
        verification: "verified",
        method: "independent",
      };
    return pending;
  }
}
