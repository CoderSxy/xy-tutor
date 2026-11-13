import { describe, expect, it } from "vitest";
import {
  instantiateTemplate,
  TemplateValidationError,
} from "../../apps/server/src/modules/question-bank/templates.js";
import { equivalent } from "../../apps/server/src/modules/learning/verifier.js";

function rejects(
  params: unknown,
  code: string,
  templateCode = "rational_arithmetic",
) {
  try {
    instantiateTemplate(templateCode, 1, params);
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateValidationError);
    expect((error as TemplateValidationError).code).toBe(code);
    return;
  }
  throw new Error("expected template validation to fail");
}

describe("rational_arithmetic template", () => {
  it("computes addition and reduces the fraction", () => {
    const q = instantiateTemplate("rational_arithmetic", 1, {
      a: 1,
      b: 2,
      c: 1,
      d: 2,
      op: "+",
    });
    expect(q.answerType).toBe("number");
    expect(q.answer).toBe("1");
    expect(equivalent(q.answer, "2/2", "number")).toBe(true);
  });

  it("keeps negative results and reduces them", () => {
    const q = instantiateTemplate("rational_arithmetic", 1, {
      a: 1,
      b: 3,
      c: 5,
      d: 6,
      op: "-",
    });
    expect(q.answer).toBe("-1/2");
    expect(equivalent(q.answer, "-2/4", "number")).toBe(true);
  });

  it("rejects a zero denominator", () => {
    rejects({ a: 1, b: 0, c: 1, d: 2, op: "+" }, "ZERO_DENOMINATOR");
    rejects({ a: 1, b: 2, c: 1, d: 0, op: "*" }, "ZERO_DENOMINATOR");
  });

  it("rejects division by a zero numerator", () => {
    rejects({ a: 1, b: 2, c: 0, d: 3, op: "/" }, "DIVISION_BY_ZERO");
  });

  it("rejects out-of-range parameters", () => {
    rejects({ a: 101, b: 2, c: 1, d: 2, op: "+" }, "PARAM_OUT_OF_RANGE");
  });

  it("rejects malformed parameters", () => {
    rejects({ a: 1, b: 2, c: 1, d: 2, op: "%" }, "PARAM_INVALID");
  });

  it("fingerprints identical parameters identically", () => {
    const params = { a: 3, b: 4, c: 5, d: 7, op: "*" };
    const first = instantiateTemplate("rational_arithmetic", 1, params);
    const second = instantiateTemplate("rational_arithmetic", 1, {
      ...params,
    });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats reduced and unreduced parameter fractions as the same instance", () => {
    const first = instantiateTemplate("rational_arithmetic", 1, {
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      op: "+",
    });
    const second = instantiateTemplate("rational_arithmetic", 1, {
      a: 2,
      b: 4,
      c: 6,
      d: 8,
      op: "+",
    });
    expect(first.answer).toBe(second.answer);
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("uses different fingerprints for different parameters", () => {
    const first = instantiateTemplate("rational_arithmetic", 1, {
      a: 1,
      b: 2,
      c: 1,
      d: 3,
      op: "+",
    });
    const second = instantiateTemplate("rational_arithmetic", 1, {
      a: 1,
      b: 2,
      c: 1,
      d: 4,
      op: "+",
    });
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });
});

describe("linear_equation template", () => {
  it("solves a(x+b)=c with integral answers", () => {
    const q = instantiateTemplate("linear_equation", 1, { a: 3, b: -2, c: 12 });
    expect(q.answerType).toBe("number");
    expect(q.answer).toBe("6");
    expect(q.stem).toContain("x");
    expect(q.stem).toContain("12");
  });

  it("solves to a reduced fraction", () => {
    const q = instantiateTemplate("linear_equation", 1, { a: 2, b: 1, c: 5 });
    expect(q.answer).toBe("3/2");
    expect(equivalent(q.answer, "1.5", "number")).toBe(true);
  });

  it("rejects a=0", () => {
    rejects({ a: 0, b: 1, c: 2 }, "ZERO_COEFFICIENT", "linear_equation");
  });

  it("handles negative parameters within bounds", () => {
    const q = instantiateTemplate("linear_equation", 1, { a: -4, b: 3, c: -8 });
    expect(q.answer).toBe("-1");
  });

  it("rejects out-of-range and malformed parameters", () => {
    rejects({ a: 21, b: 0, c: 3 }, "PARAM_OUT_OF_RANGE", "linear_equation");
    rejects({ a: 2, b: 0, c: "3" }, "PARAM_INVALID", "linear_equation");
  });

  it("rejects unknown versions", () => {
    expect(() =>
      instantiateTemplate("linear_equation", 2, { a: 2, b: 1, c: 4 }),
    ).toThrow(TemplateValidationError);
  });
});
