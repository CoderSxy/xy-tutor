import { describe, expect, it } from "vitest";
import {
  timingEventBatchSchema,
  timingEventSchema,
  timingSummarySchema,
  type TimingEventInput,
} from "../../packages/contracts/src/learning-timing.js";
import {
  attemptTimingInputSchema,
  diagnosisSchema,
  episodeSchema,
  tutoringActionInputSchema,
} from "../../packages/contracts/src/tutoring.js";
import { diagnosisReviewInputSchema } from "../../packages/contracts/src/learning-evaluation.js";

const event: TimingEventInput = {
  eventId: "11111111-1111-4111-8111-111111111111",
  episodeId: "22222222-2222-4222-8222-222222222222",
  leaseEpoch: 1,
  seq: 1,
  segmentId: "33333333-3333-4333-8333-333333333333",
  kind: "checkpoint",
  cumulativeActiveMs: 15_000,
  phase: "initial",
  expectedVersion: 1,
};

describe("timing contracts", () => {
  it("accepts a valid event", () => {
    expect(timingEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects negative and non-integer active time", () => {
    expect(
      timingEventSchema.safeParse({ ...event, cumulativeActiveMs: -1 }).success,
    ).toBe(false);
    expect(
      timingEventSchema.safeParse({ ...event, cumulativeActiveMs: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects seq 0 and non-positive lease epochs", () => {
    expect(timingEventSchema.safeParse({ ...event, seq: 0 }).success).toBe(
      false,
    );
    expect(
      timingEventSchema.safeParse({ ...event, leaseEpoch: 0 }).success,
    ).toBe(false);
  });

  it("rejects a batch over 20 events", () => {
    const batch = Array.from({ length: 21 }, (_, index) => ({
      ...event,
      seq: index + 1,
    }));
    expect(timingEventBatchSchema.safeParse(batch).success).toBe(false);
    expect(timingEventBatchSchema.safeParse(batch.slice(0, 20)).success).toBe(
      true,
    );
  });

  it("keeps missing time as null rather than zero", () => {
    expect(
      timingSummarySchema.safeParse({
        firstAttemptMs: null,
        selfCheckMs: null,
        postHintMs: null,
        totalActiveMs: null,
        wallMs: null,
        quality: "missing",
        reasonCodes: ["not_collected"],
      }).success,
    ).toBe(true);
  });
});

describe("tutoring contracts", () => {
  it("requires a positive integer expected version", () => {
    for (const expectedVersion of [0, -1, 1.5]) {
      expect(
        tutoringActionInputSchema.safeParse({
          requestKey: "req-1",
          expectedVersion,
          kind: "request_hint",
        }).success,
      ).toBe(false);
    }
  });

  it("bounds action request keys", () => {
    expect(
      tutoringActionInputSchema.safeParse({
        requestKey: "",
        expectedVersion: 1,
        kind: "request_hint",
      }).success,
    ).toBe(false);
    expect(
      tutoringActionInputSchema.safeParse({
        requestKey: "x".repeat(121),
        expectedVersion: 1,
        kind: "request_hint",
      }).success,
    ).toBe(false);
  });

  it("rejects client-supplied identity fields", () => {
    expect(
      tutoringActionInputSchema.safeParse({
        requestKey: "req-1",
        expectedVersion: 1,
        kind: "request_hint",
        studentId: "44444444-4444-4444-8444-444444444444",
      }).success,
    ).toBe(false);
  });

  it("allows at most three diagnosis candidates", () => {
    const candidate = {
      code: "concept_gap" as const,
      skillId: null,
      status: "hypothesis" as const,
      earliestError: null,
      supports: [],
      contradicts: [],
      probe: null,
    };
    const base = {
      id: "55555555-5555-4555-8555-555555555555",
      attemptId: "66666666-6666-4666-8666-666666666666",
      version: 1,
      status: "pending" as const,
      primaryCode: null,
      summary: "",
      evidence: [],
      ruleVersion: "diagnosis-v1",
    };
    expect(
      diagnosisSchema.safeParse({
        ...base,
        candidates: [candidate, candidate, candidate],
      }).success,
    ).toBe(true);
    expect(
      diagnosisSchema.safeParse({
        ...base,
        candidates: [candidate, candidate, candidate, candidate],
      }).success,
    ).toBe(false);
  });

  it("keeps the episode timing summary optional by default", () => {
    expect(attemptTimingInputSchema.safeParse({}).success).toBe(true);
  });
});

describe("diagnosis review contracts", () => {
  const review = {
    diagnosisId: "2f1c9e3a-1111-4d4d-8a8a-0a0a0a0a0a0a",
    expectedVersion: 1,
    decision: "correct" as const,
    correctedCode: "concept_gap" as const,
    reason: "学生实际未掌握负号乘法",
    evidence: [],
    requestKey: "review-1",
  };

  it("requires a corrected code when correcting", () => {
    expect(
      diagnosisReviewInputSchema.safeParse({ ...review, correctedCode: null })
        .success,
    ).toBe(false);
    expect(diagnosisReviewInputSchema.safeParse(review).success).toBe(true);
  });

  it("requires a reason", () => {
    expect(
      diagnosisReviewInputSchema.safeParse({ ...review, reason: "  " }).success,
    ).toBe(false);
  });
});

describe("episode contract", () => {
  it("requires ISO timestamps and a valid teaching state", () => {
    const episode = {
      id: "77777777-7777-4777-8777-777777777777",
      studentId: "88888888-8888-4888-8888-888888888888",
      taskId: "99999999-9999-4999-8999-999999999999",
      questionVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      version: 1,
      leaseEpoch: 1,
      lastSeq: 0,
      state: "active",
      teachingState: "awaiting_evidence",
      exposure: "none",
      leaseExpiresAt: "2026-11-13T00:01:00.000Z",
      serverAt: "2026-11-13T00:00:00.000Z",
      priorExposure: false,
      timing: {
        firstAttemptMs: null,
        selfCheckMs: null,
        postHintMs: null,
        totalActiveMs: null,
        wallMs: null,
        quality: "missing",
        reasonCodes: ["not_collected"],
      },
    };
    expect(episodeSchema.safeParse(episode).success).toBe(true);
    expect(
      episodeSchema.safeParse({ ...episode, teachingState: "chatting" }).success,
    ).toBe(false);
  });
});
