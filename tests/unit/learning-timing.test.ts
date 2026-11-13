import { describe, it, expect } from "vitest";
import type {
  TimingEventInput,
  TimingSegment,
  TimingState,
} from "../../packages/contracts/src/learning-timing.js";
import {
  qualityFromReasons,
  reduceTiming,
  summarizeTiming,
} from "../../apps/server/src/modules/tutoring/timing-rules.js";

const EPISODE = "00000000-0000-4000-8000-000000000001";
const SEG_1 = "00000000-0000-4000-8000-0000000000a1";
const SEG_2 = "00000000-0000-4000-8000-0000000000a2";
const T0 = new Date("2026-11-13T09:00:00.000Z");

const at = (ms: number) => new Date(T0.getTime() + ms);
const iso = (date: Date) => date.toISOString();

function baseState(overrides: Partial<TimingState> = {}): TimingState {
  return {
    episodeId: EPISODE,
    state: "active",
    leaseEpoch: 1,
    version: 1,
    lastSeq: 0,
    segmentId: null,
    segmentStartedAt: null,
    eventsInSegment: 0,
    lastReceivedAt: null,
    lastCumulativeMs: 0,
    firstSubmittedAt: null,
    phase: "initial",
    reasons: [],
    ...overrides,
  };
}

let seq = 0;
function event(overrides: Partial<TimingEventInput> = {}): TimingEventInput {
  seq += 1;
  return {
    eventId: crypto.randomUUID(),
    episodeId: EPISODE,
    leaseEpoch: 1,
    seq,
    segmentId: SEG_1,
    kind: "checkpoint",
    cumulativeActiveMs: 0,
    phase: "initial",
    expectedVersion: 1,
    ...overrides,
  };
}

describe("reduceTiming", () => {
  it("caps the first checkpoint at the server-measured elapsed time", () => {
    const started = reduceTiming(baseState(), event({ kind: "start" }), T0);
    const checkpoint = reduceTiming(
      started.state,
      event({ kind: "checkpoint", cumulativeActiveMs: 20_000 }),
      at(15_000),
    );

    expect(checkpoint.acceptedMs).toBe(15_000);
    expect(checkpoint.state.lastCumulativeMs).toBe(15_000);
    expect(checkpoint.state.reasons).toContain("clipped");
    expect(qualityFromReasons(checkpoint.state.reasons)).toBe("partial");
  });

  it("recovers client time across uneven heartbeat delivery", () => {
    let state = reduceTiming(baseState(), event({ kind: "start" }), T0).state;
    state = reduceTiming(
      state,
      event({ cumulativeActiveMs: 20_000 }),
      at(15_000),
    ).state;
    state = reduceTiming(
      state,
      event({ cumulativeActiveMs: 15_000 }),
      at(20_000),
    ).state;
    const last = reduceTiming(
      state,
      event({ cumulativeActiveMs: 30_000 }),
      at(30_000),
    );

    expect(last.acceptedMs).toBe(15_000);
    expect(last.state.lastCumulativeMs).toBe(30_000);
    expect(last.state.reasons).not.toContain("clipped");
  });

  it("rejects a backwards client cumulative and marks the segment unusable", () => {
    let state = reduceTiming(baseState(), event({ kind: "start" }), T0).state;
    state = reduceTiming(
      state,
      event({ cumulativeActiveMs: 20_000 }),
      at(20_000),
    ).state;
    const backwards = reduceTiming(
      state,
      event({ cumulativeActiveMs: 5_000 }),
      at(25_000),
    );

    expect(backwards.acceptedMs).toBe(0);
    expect(backwards.state.reasons).toContain("client_clock_regression");
    expect(qualityFromReasons(backwards.state.reasons)).toBe("unusable");
  });

  it("rejects server clock regression", () => {
    let state = reduceTiming(baseState(), event({ kind: "start" }), T0).state;
    state = reduceTiming(
      state,
      event({ cumulativeActiveMs: 15_000 }),
      at(15_000),
    ).state;
    const regressed = reduceTiming(
      state,
      event({ cumulativeActiveMs: 30_000 }),
      at(5_000),
    );

    expect(regressed.acceptedMs).toBe(0);
    expect(regressed.state.reasons).toContain("server_clock_regression");
    expect(qualityFromReasons(regressed.state.reasons)).toBe("unusable");
  });

  it("accepts nothing across an unconfirmed gap longer than the lease", () => {
    let state = reduceTiming(baseState(), event({ kind: "start" }), T0).state;
    state = reduceTiming(
      state,
      event({ cumulativeActiveMs: 15_000 }),
      at(15_000),
    ).state;
    const late = reduceTiming(
      state,
      event({ cumulativeActiveMs: 90_000 }),
      at(75_001),
    );

    expect(late.acceptedMs).toBe(0);
    expect(late.state.lastCumulativeMs).toBe(15_000);
    expect(late.state.segmentId).toBeNull();
    expect(late.state.reasons).toContain("unconfirmed_gap");
    expect(qualityFromReasons(late.state.reasons)).toBe("partial");
  });

  it("does not count the same event twice", () => {
    let state = reduceTiming(baseState(), event({ kind: "start" }), T0).state;
    const first = event({ cumulativeActiveMs: 15_000 });
    state = reduceTiming(state, first, at(15_000)).state;
    const repeat = reduceTiming(state, first, at(20_000));

    expect(repeat.duplicate).toBe(true);
    expect(repeat.acceptedMs).toBe(0);
    expect(repeat.state.lastCumulativeMs).toBe(15_000);
  });

  it("keeps counting while the student works without clicking", () => {
    let state = reduceTiming(baseState(), event({ kind: "start" }), T0).state;
    for (let i = 1; i <= 8; i += 1) {
      state = reduceTiming(
        state,
        event({ cumulativeActiveMs: i * 15_000 }),
        at(i * 15_000),
      ).state;
    }

    expect(state.lastCumulativeMs).toBe(120_000);
    expect(state.reasons).not.toContain("unconfirmed_gap");
  });

  it("starts a new segment after a pause and credits nothing to the pause", () => {
    let state = reduceTiming(baseState(), event({ kind: "start" }), T0).state;
    state = reduceTiming(
      state,
      event({ cumulativeActiveMs: 30_000 }),
      at(30_000),
    ).state;
    state = reduceTiming(
      state,
      event({ kind: "pause", cumulativeActiveMs: 30_000, seq: 900 }),
      at(30_000),
    ).state;

    expect(state.state).toBe("paused");
    expect(state.segmentId).toBeNull();
    expect(state.lastCumulativeMs).toBe(30_000);

    const resumed = reduceTiming(
      state,
      event({
        kind: "resume",
        segmentId: SEG_2,
        cumulativeActiveMs: 0,
        seq: 901,
      }),
      at(75_000),
    );
    expect(resumed.acceptedMs).toBe(0);
    expect(resumed.state.segmentId).toBe(SEG_2);
    expect(resumed.state.lastCumulativeMs).toBe(0);
    expect(resumed.state.eventsInSegment).toBe(1);

    const after = reduceTiming(
      resumed.state,
      event({ segmentId: SEG_2, cumulativeActiveMs: 15_000, seq: 902 }),
      at(90_000),
    );
    expect(after.acceptedMs).toBe(15_000);
  });

  it("rejects events from a superseded lease epoch", () => {
    const state = baseState({
      leaseEpoch: 2,
      segmentId: SEG_1,
      segmentStartedAt: iso(T0),
      lastReceivedAt: iso(T0),
    });
    const stale = reduceTiming(
      state,
      event({ leaseEpoch: 1, cumulativeActiveMs: 15_000 }),
      at(15_000),
    );

    expect(stale.acceptedMs).toBe(0);
    expect(stale.duplicate).toBe(false);
    expect(stale.state.reasons).toContain("stale_lease_epoch");
  });

  it("closes the segment once it reaches the event limit", () => {
    const state = baseState({
      segmentId: SEG_1,
      segmentStartedAt: iso(T0),
      eventsInSegment: 2_000,
      lastReceivedAt: iso(at(15_000)),
      lastCumulativeMs: 15_000,
      lastSeq: 2_000,
    });
    const blocked = reduceTiming(
      state,
      event({ cumulativeActiveMs: 30_000, seq: 2_001 }),
      at(30_000),
    );

    expect(blocked.acceptedMs).toBe(0);
    expect(blocked.state.segmentId).toBeNull();
    expect(blocked.state.reasons).toContain("event_limit_reached");

    const resumed = reduceTiming(
      blocked.state,
      event({
        kind: "resume",
        segmentId: SEG_2,
        cumulativeActiveMs: 0,
        seq: 2_002,
      }),
      at(45_000),
    );
    expect(resumed.state.segmentId).toBe(SEG_2);
    expect(resumed.state.eventsInSegment).toBe(1);
  });
});

const segment = (overrides: Partial<TimingSegment>): TimingSegment => ({
  id: crypto.randomUUID(),
  phase: "initial",
  startAt: iso(T0),
  endAt: iso(at(30_000)),
  acceptedMs: 30_000,
  quality: "reliable",
  ...overrides,
});

describe("summarizeTiming", () => {
  it("returns nulls and missing when nothing was collected", () => {
    expect(summarizeTiming([], new Date("2026-11-13T09:00:30Z"), at(90_000)))
      .toEqual({
        firstAttemptMs: null,
        selfCheckMs: null,
        postHintMs: null,
        totalActiveMs: null,
        wallMs: null,
        quality: "missing",
        reasonCodes: ["not_collected"],
      });
  });

  it("aggregates exclusive windows at the first submission boundary", () => {
    const summary = summarizeTiming(
      [
        segment({ phase: "initial", endAt: iso(at(30_000)), acceptedMs: 30_000 }),
        segment({
          phase: "self_check",
          startAt: iso(at(30_000)),
          endAt: iso(at(60_000)),
          acceptedMs: 20_000,
          quality: "partial",
        }),
        segment({
          phase: "post_hint",
          startAt: iso(at(60_000)),
          endAt: iso(at(90_000)),
          acceptedMs: 25_000,
        }),
      ],
      at(30_000),
      at(90_000),
    );

    expect(summary).toEqual({
      firstAttemptMs: 30_000,
      selfCheckMs: 20_000,
      postHintMs: 25_000,
      totalActiveMs: 75_000,
      wallMs: 90_000,
      quality: "partial",
      reasonCodes: ["partial_segment"],
    });
  });

  it("clips a segment crossing the boundary without double counting it", () => {
    const summary = summarizeTiming(
      [
        segment({
          phase: "post_hint",
          startAt: iso(at(0)),
          endAt: iso(at(60_000)),
          acceptedMs: 60_000,
        }),
      ],
      at(30_000),
      at(60_000),
    );

    expect(summary.firstAttemptMs).toBe(30_000);
    expect(summary.postHintMs).toBe(30_000);
    expect(summary.totalActiveMs).toBe(60_000);
  });

  it("marks unusable segments unusable and open segments partial", () => {
    const unusable = summarizeTiming(
      [segment({ quality: "unusable", acceptedMs: 0 })],
      at(30_000),
      at(60_000),
    );
    expect(unusable.quality).toBe("unusable");
    expect(unusable.reasonCodes).toContain("unusable_segment");

    const open = summarizeTiming(
      [segment({ endAt: null, acceptedMs: 15_000 })],
      null,
      null,
    );
    expect(open.quality).toBe("partial");
    expect(open.reasonCodes).toContain("open_segment");
    expect(open.firstAttemptMs).toBeNull();
    expect(open.wallMs).toBeNull();
  });
});
