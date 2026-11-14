import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createTimingClient } from "../../apps/web/src/features/tutoring/timing-client";
import type { TimingEventInput } from "../../packages/contracts/src/learning-timing.js";
import type { EpisodeDTO } from "../../packages/contracts/src/tutoring.js";

function episode(overrides: Partial<EpisodeDTO> = {}): EpisodeDTO {
  return {
    id: randomUUID(),
    studentId: randomUUID(),
    taskId: randomUUID(),
    questionVersionId: randomUUID(),
    version: 1,
    leaseEpoch: 1,
    lastSeq: 0,
    state: "active",
    teachingState: "self_check",
    exposure: "none",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    serverAt: new Date().toISOString(),
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
    ...overrides,
  };
}

function harness() {
  let clock = 0;
  let epoch = 1;
  const sent: TimingEventInput[][] = [];
  const seen = new Set<string>();
  const store = new Map<string, EpisodeDTO>();
  const start = vi.fn(async () => {
    const e = episode({ leaseEpoch: epoch });
    store.set(e.id, e);
    return e;
  });
  const append = vi.fn(
    async (episodeId: string, events: TimingEventInput[]) => {
      const current = store.get(episodeId)!;
      if (events.some((event) => event.leaseEpoch !== epoch))
        throw Object.assign(new Error("作答租约已被接管"), {
          status: 409,
          code: "CONFLICT",
        });
      // 服务端按 eventId 去重：重复事件只续租，不推进版本。
      if (events.every((event) => seen.has(event.eventId))) return current;
      for (const event of events) seen.add(event.eventId);
      sent.push(events);
      const next = {
        ...current,
        version: current.version + 1,
        lastSeq: Math.max(current.lastSeq, ...events.map((e) => e.seq)),
      };
      store.set(episodeId, next);
      return next;
    },
  );
  const client = createTimingClient({
    api: { start, append },
    monotonicNow: () => clock,
    newId: () => randomUUID(),
  });
  return {
    client,
    start,
    append,
    sent,
    advanceClock: (ms: number) => {
      clock += ms;
    },
    takeOverLease: () => {
      epoch += 1;
    },
  };
}

const allEvents = (sent: TimingEventInput[][]) => sent.flat();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("timing client", () => {
  it("checkpoints every 15 seconds while the segment stays open", async () => {
    const h = harness();
    expect(await h.client.start({ taskId: "t", questionVersionId: "q" })).toBe(
      true,
    );
    h.advanceClock(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    h.advanceClock(15_000);
    await vi.advanceTimersByTimeAsync(15_000);

    const checkpoints = allEvents(h.sent).filter(
      (e) => e.kind === "checkpoint",
    );
    expect(checkpoints.map((e) => e.cumulativeActiveMs)).toEqual([
      15_000, 30_000,
    ]);
    expect(h.client.snapshot().activeMs).toBe(30_000);
    h.client.dispose();
  });

  it("keeps counting while the student reads without typing", async () => {
    const h = harness();
    await h.client.start({ taskId: "t", questionVersionId: "q" });
    h.advanceClock(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.client.snapshot().activeMs).toBe(60_000);
    expect(
      allEvents(h.sent)
        .filter((e) => e.kind === "checkpoint")
        .at(-1)?.cumulativeActiveMs,
    ).toBe(60_000);
    h.client.dispose();
  });

  it("pauses on hidden and only resumes when the student asks", async () => {
    const h = harness();
    await h.client.start({ taskId: "t", questionVersionId: "q" });
    h.advanceClock(20_000);
    await h.client.pause("hidden");
    expect(h.client.snapshot()).toMatchObject({
      status: "paused",
      pauseReason: "hidden",
      activeMs: 20_000,
    });

    h.advanceClock(600_000);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.client.snapshot().status).toBe("paused");
    expect(h.client.snapshot().activeMs).toBe(20_000);
    expect(allEvents(h.sent).filter((e) => e.kind === "checkpoint")).toEqual(
      [],
    );

    await h.client.resume();
    h.advanceClock(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.client.snapshot().activeMs).toBe(35_000);
    const kinds = allEvents(h.sent).map((e) => [e.kind, e.cumulativeActiveMs]);
    expect(kinds).toEqual([
      ["start", 0],
      ["pause", 20_000],
      ["resume", 0],
      ["checkpoint", 15_000],
    ]);
    h.client.dispose();
  });

  it("freezes for offline and waiting for the tutor", async () => {
    const h = harness();
    await h.client.start({ taskId: "t", questionVersionId: "q" });
    h.advanceClock(10_000);
    await h.client.pause("offline");
    h.advanceClock(10_000);
    await h.client.resume();
    h.advanceClock(10_000);
    await h.client.pause("waiting_ai");
    expect(h.client.snapshot()).toMatchObject({
      status: "paused",
      pauseReason: "waiting_ai",
      activeMs: 20_000,
    });
    h.client.dispose();
  });

  it("stops all timers after dispose", async () => {
    const h = harness();
    await h.client.start({ taskId: "t", questionVersionId: "q" });
    h.client.dispose();
    expect(vi.getTimerCount()).toBe(0);
    const before = h.sent.length;
    h.advanceClock(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sent.length).toBe(before);
  });

  it("starts a single episode even when start is called twice", async () => {
    const h = harness();
    const [first, second] = await Promise.all([
      h.client.start({ taskId: "t", questionVersionId: "q" }),
      h.client.start({ taskId: "t", questionVersionId: "q" }),
    ]);
    expect([first, second]).toEqual([true, true]);
    expect(h.start).toHaveBeenCalledTimes(1);
    await h.client.start({ taskId: "t", questionVersionId: "q" });
    expect(h.start).toHaveBeenCalledTimes(1);
    h.client.dispose();
  });

  it("closes the segment with a final event for the answer", async () => {
    const h = harness();
    await h.client.start({ taskId: "t", questionVersionId: "q" });
    h.advanceClock(42_000);
    const submission = await h.client.prepareSubmission();
    expect(submission.episodeId).toBeTruthy();
    expect(submission.timingFinalEvent).toMatchObject({
      kind: "finish",
      cumulativeActiveMs: 42_000,
      episodeId: submission.episodeId,
    });
    expect(h.client.snapshot().status).toBe("paused");
    expect(vi.getTimerCount()).toBe(1);
    h.client.dispose();
  });

  it("sends nothing to the answer when no episode was started", async () => {
    const h = harness();
    expect(await h.client.prepareSubmission()).toEqual({});
    expect(h.start).not.toHaveBeenCalled();
  });

  it("reports a taken-over lease instead of pretending to keep timing", async () => {
    const h = harness();
    await h.client.start({ taskId: "t", questionVersionId: "q" });
    h.takeOverLease();
    h.advanceClock(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    const snapshot = h.client.snapshot();
    expect(snapshot.status).toBe("finished");
    expect(snapshot.error).toContain("接管");
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("resumes the same teaching episode for correction after submitting", async () => {
  const h = harness();
  await h.client.start({ taskId: "t", questionVersionId: "q" });
  const first = await h.client.prepareSubmission();
  await h.client.resume();
  h.advanceClock(10_000);
  const second = await h.client.prepareSubmission();
  expect(second.episodeId).toBe(first.episodeId);
  expect(second.timingFinalEvent?.eventId).not.toBe(
    first.timingFinalEvent?.eventId,
  );
  expect(second.timingFinalEvent?.phase).toBe("self_check");
  expect(second.timingFinalEvent?.cumulativeActiveMs).toBe(10_000);
  h.client.dispose();
});

it("does not send an unsubmitted final event while keeping a delayed answer alive", async () => {
  const h = harness();
  await h.client.start({ taskId: "t", questionVersionId: "q" });
  const submission = await h.client.prepareSubmission();
  await vi.advanceTimersByTimeAsync(30_000);
  const delivered = h.append.mock.calls.flatMap((call) => call[1]);
  expect(
    delivered.some(
      (event) => event.eventId === submission.timingFinalEvent?.eventId,
    ),
  ).toBe(false);
  h.client.dispose();
});
