import {
  TIMING_LIMITS,
  type TimingEventInput,
  type TimingQuality,
  type TimingReduction,
  type TimingSegment,
  type TimingState,
  type TimingSummary,
} from "../../../../../packages/contracts/src/learning-timing.js";

const UNUSABLE_REASONS = new Set([
  "server_clock_regression",
  "client_clock_regression",
  "episode_mismatch",
]);

const PARTIAL_REASONS = new Set([
  "incomplete_submission",
  "clipped",
  "unconfirmed_gap",
  "event_limit_reached",
  "no_open_segment",
  "phase_mismatch",
  "stale_lease_epoch",
  "segment_already_open",
  "episode_finished",
]);

export function qualityFromReasons(
  reasons: readonly string[],
): TimingSegment["quality"] {
  if (reasons.some((reason) => UNUSABLE_REASONS.has(reason))) return "unusable";
  if (reasons.some((reason) => PARTIAL_REASONS.has(reason))) return "partial";
  return "reliable";
}

function mergeReasons(
  current: readonly string[],
  added: readonly string[],
): string[] {
  const merged = [...current];
  for (const reason of added) {
    if (!merged.includes(reason)) merged.push(reason);
  }
  return merged;
}

function withoutSegment(state: TimingState, reasons: string[]): TimingState {
  return {
    ...state,
    segmentId: null,
    segmentStartedAt: null,
    eventsInSegment: 0,
    reasons: mergeReasons(state.reasons, reasons),
  };
}

/**
 * Pure reducer: server state + one accepted event -> new state and the
 * amount of time the server is willing to credit. Never reads a clock.
 */
export function reduceTiming(
  state: TimingState,
  event: TimingEventInput,
  receivedAt: Date,
): TimingReduction {
  const receivedMs = receivedAt.getTime();
  const lastReceivedMs = state.lastReceivedAt
    ? Date.parse(state.lastReceivedAt)
    : null;

  if (event.episodeId !== state.episodeId) {
    return {
      state: {
        ...state,
        reasons: mergeReasons(state.reasons, ["episode_mismatch"]),
      },
      acceptedMs: 0,
      duplicate: false,
    };
  }

  if (event.leaseEpoch !== state.leaseEpoch) {
    return {
      state: {
        ...state,
        reasons: mergeReasons(state.reasons, ["stale_lease_epoch"]),
      },
      acceptedMs: 0,
      duplicate: false,
    };
  }

  if (event.seq <= state.lastSeq) {
    return { state, acceptedMs: 0, duplicate: true };
  }

  if (state.state === "finished") {
    return {
      state: {
        ...state,
        lastSeq: event.seq,
        reasons: mergeReasons(state.reasons, ["episode_finished"]),
      },
      acceptedMs: 0,
      duplicate: false,
    };
  }

  if (lastReceivedMs !== null && receivedMs < lastReceivedMs) {
    return {
      state: {
        ...state,
        lastSeq: event.seq,
        reasons: mergeReasons(state.reasons, ["server_clock_regression"]),
      },
      acceptedMs: 0,
      duplicate: false,
    };
  }

  if (event.kind === "start" || event.kind === "resume") {
    if (state.segmentId !== null && state.segmentId !== event.segmentId) {
      return {
        state: {
          ...state,
          lastSeq: event.seq,
          reasons: mergeReasons(state.reasons, ["segment_already_open"]),
        },
        acceptedMs: 0,
        duplicate: false,
      };
    }
    const phaseMismatch = event.phase !== state.phase;
    return {
      state: {
        ...state,
        state: "active",
        segmentId: event.segmentId,
        segmentStartedAt: receivedAt.toISOString(),
        eventsInSegment: 1,
        lastReceivedAt: receivedAt.toISOString(),
        lastCumulativeMs: 0,
        lastSeq: event.seq,
        reasons: mergeReasons(state.reasons, phaseMismatch ? ["phase_mismatch"] : []),
      },
      acceptedMs: 0,
      duplicate: false,
    };
  }

  if (state.segmentId === null || state.segmentId !== event.segmentId) {
    return {
      state: withoutSegment(state, ["no_open_segment"]),
      acceptedMs: 0,
      duplicate: false,
    };
  }

  if (state.eventsInSegment >= TIMING_LIMITS.maxEpisodeEvents) {
    return {
      state: {
        ...withoutSegment(state, ["event_limit_reached"]),
        lastSeq: event.seq,
      },
      acceptedMs: 0,
      duplicate: false,
    };
  }

  const gapMs = lastReceivedMs === null ? 0 : receivedMs - lastReceivedMs;
  if (gapMs > TIMING_LIMITS.leaseMs) {
    return {
      state: {
        ...withoutSegment(state, ["unconfirmed_gap"]),
        lastReceivedAt: receivedAt.toISOString(),
        lastSeq: event.seq,
      },
      acceptedMs: 0,
      duplicate: false,
    };
  }

  const anchorMs = state.segmentStartedAt
    ? Date.parse(state.segmentStartedAt)
    : receivedMs;
  const serverElapsed = Math.max(0, receivedMs - anchorMs);

  const reasons: string[] = [];
  let target = Math.min(event.cumulativeActiveMs, serverElapsed);
  if (event.cumulativeActiveMs < state.lastCumulativeMs) {
    reasons.push("client_clock_regression");
    target = state.lastCumulativeMs;
  } else if (event.cumulativeActiveMs > serverElapsed) {
    reasons.push("clipped");
  }
  if (event.phase !== state.phase) reasons.push("phase_mismatch");

  const acceptedMs = Math.max(0, target - state.lastCumulativeMs);
  const closing = event.kind === "pause" || event.kind === "finish";
  // Clipping is a current, not historical, condition: only a segment that is
  // still clipped when it closes counts as partial.
  const carried = state.reasons.filter((reason) => reason !== "clipped");

  return {
    state: {
      ...state,
      state: closing
        ? event.kind === "finish"
          ? "finished"
          : "paused"
        : state.state,
      segmentId: closing ? null : state.segmentId,
      segmentStartedAt: closing ? null : state.segmentStartedAt,
      eventsInSegment: closing ? 0 : state.eventsInSegment + 1,
      lastReceivedAt: receivedAt.toISOString(),
      lastCumulativeMs: Math.max(state.lastCumulativeMs, target),
      lastSeq: event.seq,
      reasons: mergeReasons(carried, reasons),
    },
    acceptedMs,
    duplicate: false,
  };
}

function overlapMs(
  segmentStart: number,
  segmentEnd: number,
  windowStart: number,
  windowEnd: number,
): number {
  return Math.max(0, Math.min(segmentEnd, windowEnd) - Math.max(segmentStart, windowStart));
}

/**
 * Aggregates stored segments into the reported windows. Segments never
 * overlap in wall time, so totalActiveMs is their plain sum; the first
 * attempt window is clipped at the frozen first-submission boundary and
 * the later windows start there.
 */
export function summarizeTiming(
  segments: readonly TimingSegment[],
  firstSubmittedAt: Date | null,
  endedAt: Date | null,
): TimingSummary {
  if (segments.length === 0) {
    return {
      firstAttemptMs: null,
      selfCheckMs: null,
      postHintMs: null,
      totalActiveMs: null,
      wallMs: null,
      quality: "missing",
      reasonCodes: ["not_collected"],
    };
  }

  const startMs = Math.min(...segments.map((s) => Date.parse(s.startAt)));
  const endMs = endedAt ? endedAt.getTime() : null;
  const boundary = firstSubmittedAt ? firstSubmittedAt.getTime() : null;

  let firstAttemptMs = boundary === null ? null : 0;
  let selfCheckMs = boundary === null ? null : 0;
  let postHintMs = boundary === null ? null : 0;
  let totalActiveMs = 0;
  let quality: TimingQuality = "reliable";
  const reasonCodes: string[] = [];
  const note = (reason: string) => {
    if (!reasonCodes.includes(reason)) reasonCodes.push(reason);
  };
  const degrade = (next: TimingSegment["quality"]) => {
    if (next === "unusable") quality = "unusable";
    else if (next === "partial" && quality !== "unusable") quality = "partial";
  };

  for (const seg of segments) {
    const segStart = Date.parse(seg.startAt);
    const segEnd = seg.endAt ? Date.parse(seg.endAt) : (endMs ?? segStart);
    totalActiveMs += seg.acceptedMs;

    if (seg.quality !== "reliable") {
      degrade(seg.quality);
      note(seg.quality === "unusable" ? "unusable_segment" : "partial_segment");
    }
    if (seg.endAt === null) {
      degrade("partial");
      note("open_segment");
    }

    if (boundary === null) continue;
    if (segStart < boundary && firstAttemptMs !== null) {
      firstAttemptMs += Math.min(
        seg.acceptedMs,
        overlapMs(segStart, segEnd, segStart, boundary),
      );
    }
    if (seg.phase === "self_check" && selfCheckMs !== null) {
      selfCheckMs += Math.min(
        seg.acceptedMs,
        overlapMs(segStart, segEnd, boundary, segEnd),
      );
    }
    if (seg.phase === "post_hint" && postHintMs !== null) {
      postHintMs += Math.min(
        seg.acceptedMs,
        overlapMs(segStart, segEnd, boundary, segEnd),
      );
    }
  }

  return {
    firstAttemptMs,
    selfCheckMs,
    postHintMs,
    totalActiveMs,
    wallMs: endMs === null ? null : Math.max(0, endMs - startMs),
    quality,
    reasonCodes,
  };
}
