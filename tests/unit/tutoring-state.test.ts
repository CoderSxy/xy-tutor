import { describe, expect, it } from "vitest";
import type { EpisodeDTO } from "../../packages/contracts/src/tutoring.js";
import {
  ANCHOR_VERSION,
  ANCHORS,
  anchorForCode,
} from "../../apps/server/src/modules/tutoring/anchors.js";
import {
  combineHintDependency,
  decideTeachingTransition,
  nextFailedChecks,
} from "../../apps/server/src/modules/tutoring/state-rules.js";

function episode(
  teachingState: EpisodeDTO["teachingState"],
  exposure: EpisodeDTO["exposure"] = "none",
): EpisodeDTO {
  return {
    id: crypto.randomUUID(),
    studentId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    questionVersionId: crypto.randomUUID(),
    version: 3,
    leaseEpoch: 1,
    lastSeq: 0,
    state: "active",
    teachingState,
    exposure,
    leaseExpiresAt: new Date().toISOString(),
    serverAt: new Date().toISOString(),
    priorExposure: false,
    timing: {
      firstAttemptMs: null,
      selfCheckMs: null,
      postHintMs: null,
      totalActiveMs: null,
      wallMs: null,
      quality: "missing",
      reasonCodes: [],
    },
  } as EpisodeDTO;
}

const action = (kind: Parameters<typeof decideTeachingTransition>[0]["action"]["kind"]) =>
  ({ requestKey: "req", expectedVersion: 3, kind }) as const;

describe("versioned anchors", () => {
  it("ships all eight anchors with first-use examples and counterexamples", () => {
    expect(ANCHOR_VERSION).toBe("anchors-v1");
    expect(ANCHORS.map((anchor) => anchor.code).sort()).toEqual(
      [
        "align_units",
        "balance_equation",
        "check_in_original",
        "check_preconditions",
        "conditions_on_diagram",
        "restate_goal",
        "sign_tracking",
        "write_key_steps",
      ].sort(),
    );
    for (const anchor of ANCHORS) {
      expect(anchor.version).toBe(ANCHOR_VERSION);
      expect(anchor.appliesTo.length).toBeGreaterThan(0);
      expect(anchor.action.length).toBeGreaterThan(0);
      expect(anchor.example.length).toBeGreaterThan(0);
      expect(anchor.counterexample.length).toBeGreaterThan(0);
      expect(anchor.hint.length).toBeGreaterThan(0);
    }
  });

  it("maps each diagnosis code to a concrete anchor", () => {
    expect(anchorForCode("condition_omission").code).toBe("conditions_on_diagram");
    expect(anchorForCode("rule_misuse").code).toBe("check_preconditions");
    expect(anchorForCode("execution_slip").code).toBe("write_key_steps");
    expect(anchorForCode("strategy_gap").code).toBe("restate_goal");
    expect(anchorForCode("expression_gap").code).toBe("restate_goal");
    expect(anchorForCode("input_issue").code).toBe("check_preconditions");
    expect(anchorForCode("concept_gap").code).toBe("check_in_original");
    expect(anchorForCode(null).code).toBe("write_key_steps");
  });
});

describe("teaching transition", () => {
  it("never repeats the same unsuccessful check level", () => {
    expect(
      decideTeachingTransition({
        episode: episode("awaiting_evidence"),
        diagnosis: null,
        action: action("request_hint"),
        failedChecks: 0,
      }).next,
    ).toBe("self_check");
    expect(
      decideTeachingTransition({
        episode: episode("self_check"),
        diagnosis: null,
        action: action("request_hint"),
        failedChecks: 1,
      }).next,
    ).toBe("focused_check");
    expect(
      decideTeachingTransition({
        episode: episode("focused_check"),
        diagnosis: null,
        action: action("request_hint"),
        failedChecks: 1,
      }).next,
    ).toBe("micro_probe");
  });

  it("moves to a probe or explanation after two checks without progress", () => {
    expect(
      decideTeachingTransition({
        episode: episode("self_check"),
        diagnosis: null,
        action: action("request_hint"),
        failedChecks: 2,
      }).next,
    ).toBe("micro_probe");
    expect(
      decideTeachingTransition({
        episode: episode("micro_probe"),
        diagnosis: null,
        action: action("request_hint"),
        failedChecks: 2,
      }).next,
    ).toBe("explanation");
  });

  it("allows at most two micro probes before explaining", () => {
    expect(
      decideTeachingTransition({
        episode: episode("focused_check"),
        diagnosis: null,
        action: action("request_probe"),
        failedChecks: 1,
      }).next,
    ).toBe("micro_probe");
    expect(
      decideTeachingTransition({
        episode: episode("micro_probe"),
        diagnosis: null,
        action: action("request_probe"),
        failedChecks: 3,
      }).next,
    ).toBe("explanation");
  });

  it("goes straight to explanation for a confirmed knowledge gap", () => {
    const decision = decideTeachingTransition({
      episode: episode("awaiting_evidence"),
      diagnosis: {
        id: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        version: 1,
        status: "confirmed",
        primaryCode: "concept_gap",
        candidates: [],
        summary: "分数的基本性质没有建立",
        evidence: [],
        ruleVersion: "diagnosis-v1",
      },
      action: action("request_hint"),
      failedChecks: 0,
    });
    expect(decision.next).toBe("explanation");
    expect(decision.exposure).toBe("guided");
  });

  it("lets a student jump straight to a full explanation", () => {
    const decision = decideTeachingTransition({
      episode: episode("self_check", "guided"),
      diagnosis: null,
      action: action("request_explanation"),
      failedChecks: 1,
    });
    expect(decision.next).toBe("explanation");
    expect(decision.exposure).toBe("solution_exposed");
  });

  it("keeps pause, resume and acknowledgement from advancing the state", () => {
    for (const kind of ["pause", "resume", "acknowledge_display"] as const) {
      const decision = decideTeachingTransition({
        episode: episode("focused_check", "guided"),
        diagnosis: null,
        action: action(kind),
        failedChecks: 1,
      });
      expect(decision.next).toBe("focused_check");
      expect(decision.exposure).toBe("guided");
    }
  });

  it("does not count repeated requests as new failed checks", () => {
    expect(nextFailedChecks(1, false)).toBe(1);
    expect(nextFailedChecks(1, true)).toBe(2);
    expect(nextFailedChecks(0, false)).toBe(0);
  });

  it("combines exposure evidence with the most revealing source winning", () => {
    expect(
      combineHintDependency({ hints: [], actions: [], unattributed: "none" }),
    ).toBe("none");
    expect(
      combineHintDependency({
        hints: ["guided"],
        actions: ["unknown"],
        unattributed: "none",
      }),
    ).toBe("unknown");
    expect(
      combineHintDependency({
        hints: ["solution_exposed"],
        actions: ["unknown"],
        unattributed: "guided",
      }),
    ).toBe("solution_exposed");
    expect(
      combineHintDependency({
        hints: ["guided"],
        actions: [],
        unattributed: "unknown",
      }),
    ).toBe("unknown");
  });
});
