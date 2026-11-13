import { describe, expect, it } from "vitest";
import {
  decideDiagnosis,
  DIAGNOSIS_RULE_VERSION,
} from "../../apps/server/src/modules/tutoring/diagnosis-rules.js";
import type {
  DiagnosisCandidate,
  DiagnosisContext,
} from "../../packages/contracts/src/tutoring.js";

const step = {
  kind: "process_step",
  id: "10000000-0000-4000-8000-000000000001",
};
const probe = {
  kind: "probe_response",
  id: "10000000-0000-4000-8000-000000000002",
};
const knowledge = {
  kind: "knowledge_snapshot",
  id: "10000000-0000-4000-8000-000000000003",
};

function context(overrides: Partial<DiagnosisContext> = {}): DiagnosisContext {
  return {
    assessmentId: "20000000-0000-4000-8000-000000000001",
    attemptId: "30000000-0000-4000-8000-000000000001",
    questionVersionId: "40000000-0000-4000-8000-000000000001",
    processEvidence: [step, knowledge],
    probeEvidence: [],
    assessment: { correctness: "incorrect", verification: "verified" },
    stemConfirmed: true,
    knowledgeAvailable: true,
    supportedQuestionType: true,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<DiagnosisCandidate> = {},
): DiagnosisCandidate {
  return {
    code: "execution_slip",
    skillId: null,
    status: "hypothesis",
    earliestError: step,
    supports: [step],
    contradicts: [],
    probe: "先检查去括号这一步，再重算一次。",
    ...overrides,
  };
}

describe("diagnosis rules", () => {
  it("same_answer_different_causes_stays_unconfirmed", () => {
    const result = decideDiagnosis(context(), [
      candidate({ code: "execution_slip", probe: "把去括号这一步单独算一遍。" }),
      candidate({
        code: "rule_misuse",
        probe: "-2×(-3) 等于多少？",
      }),
    ]);
    expect(result.status).toBe("needs_probe");
    expect(result.primaryCode).toBeNull();
    expect(result.candidates.every((c) => c.status !== "confirmed")).toBe(true);
    expect(result.evidence.some((ref) => ref.id === probe.id)).toBe(false);
    expect(result.ruleVersion).toBe(DIAGNOSIS_RULE_VERSION);
  });

  it("correct_but_slow_not_gap", () => {
    const result = decideDiagnosis(
      context({ assessment: { correctness: "correct", verification: "verified" } }),
      [candidate({ code: "concept_gap", supports: [step], probe: null })],
    );
    expect(result.status).toBe("unsupported");
    expect(result.primaryCode).toBeNull();
    expect(result.candidates[0]!.status).toBe("rejected");
    expect(result.summary).toContain("不需要");
  });

  it("fast_wrong_not_slip", () => {
    const timing = {
      kind: "timing_snapshot",
      id: "50000000-0000-4000-8000-000000000001",
    };
    const result = decideDiagnosis(context(), [
      candidate({
        status: "confirmed",
        supports: [timing],
        earliestError: timing,
        probe: null,
      }),
    ]);
    expect(result.status).toBe("needs_probe");
    expect(result.primaryCode).toBeNull();
    expect(result.candidates[0]!.status).toBe("hypothesis");
    expect(result.evidence.some((ref) => ref.kind === "timing_snapshot")).toBe(
      false,
    );
  });

  it("unreadable_stem_blocks_attribution", () => {
    const result = decideDiagnosis(context({ stemConfirmed: false }), [
      candidate({ status: "confirmed", probe: null }),
    ]);
    expect(result.status).toBe("pending");
    expect(result.primaryCode).toBeNull();
    expect(result.summary).toContain("题干");
  });

  it("conflicting_probe_stays_pending", () => {
    const result = decideDiagnosis(
      context({ probeEvidence: [probe] }),
      [
        candidate({
          code: "rule_misuse",
          supports: [step, probe],
          contradicts: [probe],
          probe: "再说一遍，-2×(-3) 等于多少？",
        }),
      ],
    );
    expect(result.status).toBe("needs_probe");
    expect(result.primaryCode).toBeNull();
    expect(result.candidates[0]!.status).toBe("supported");
  });

  it("alternative_valid_method_accepted", () => {
    const result = decideDiagnosis(
      context({ assessment: { correctness: "correct", verification: "verified" } }),
      [
        candidate({
          code: "strategy_gap",
          earliestError: null,
          supports: [step],
          probe: null,
        }),
      ],
    );
    expect(result.status).toBe("unsupported");
    expect(result.primaryCode).toBeNull();
    expect(result.candidates[0]!.status).toBe("rejected");
  });
});
