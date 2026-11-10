import { expect, it } from "vitest";
import type {
  InsightEvidence,
  InsightSnapshot,
} from "../../packages/contracts/src/student-insights.js";
import {
  EVIDENCE_LIMITS,
  hashInsightSnapshot,
  selectInsightEvidence,
} from "../../apps/server/src/modules/student-insights/snapshot.js";

function snapshot(dataAsOf: string, attempts = 3): InsightSnapshot {
  return {
    filter: { from: "2026-11-01", to: "2026-11-10" },
    meta: {
      from: "2026-11-01",
      to: "2026-11-10",
      timezone: "Asia/Shanghai",
      metricVersion: "student-insights-v1",
      coverage: {
        learning: "complete",
        historicalInferred: false,
        visitsStartedAt: null,
        backfillVersion: null,
      },
      dataAsOf,
    },
    overview: { attempts } as unknown as InsightSnapshot["overview"],
    evidence: [
      {
        key: "attempt:a",
        kind: "attempt",
        id: "a",
        summary: "作答",
      },
    ],
    sample: { actual: 1, selected: 1, truncated: false },
  };
}

function candidate(key: string, summary = "证据"): InsightEvidence {
  return { key, kind: "attempt", id: key, summary };
}

it("hashes business facts but ignores the request clock", () => {
  expect(hashInsightSnapshot(snapshot("2026-11-10T00:00:00.000Z"))).toBe(
    hashInsightSnapshot(snapshot("2026-11-11T00:00:00.000Z")),
  );
  expect(hashInsightSnapshot(snapshot("2026-11-10T00:00:00.000Z"))).not.toBe(
    hashInsightSnapshot(snapshot("2026-11-10T00:00:00.000Z", 4)),
  );
});

it("deduplicates evidence by key and keeps order", () => {
  const { evidence, sample } = selectInsightEvidence([
    candidate("a"),
    candidate("b"),
    candidate("a", "重复"),
  ]);
  expect(evidence.map((item) => item.key)).toEqual(["a", "b"]);
  expect(sample).toEqual({ actual: 3, selected: 2, truncated: true });
});

it("caps item count, summary length and total text budget", () => {
  const many = Array.from({ length: 5 }, (_, index) =>
    candidate(`k${index}`, "x".repeat(600)),
  );
  const limited = selectInsightEvidence(many, {
    maxItems: 2,
    maxSummaryChars: 500,
    maxTotalChars: 30_000,
  });
  expect(limited.evidence).toHaveLength(2);
  expect(limited.sample).toEqual({ actual: 5, selected: 2, truncated: true });
  for (const item of limited.evidence)
    expect([...item.summary]).toHaveLength(500);

  const tight = selectInsightEvidence(
    Array.from({ length: 4 }, (_, index) => candidate(`t${index}`, "y".repeat(400))),
    { maxItems: 100, maxSummaryChars: 500, maxTotalChars: 1_000 },
  );
  expect(tight.evidence).toHaveLength(2);
  expect(tight.sample).toEqual({ actual: 4, selected: 2, truncated: true });
});

it("uses the documented production limits", () => {
  expect(EVIDENCE_LIMITS).toEqual({
    maxItems: 100,
    maxSummaryChars: 500,
    maxTotalChars: 30_000,
  });
});
