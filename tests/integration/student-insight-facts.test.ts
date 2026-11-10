import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import {
  seedInsightFacts,
  studentInsightsFixture,
  type InsightFactsSeed,
  type StudentInsightsFixture,
} from "../helpers/student-insights.js";
import type { Database } from "../../packages/db/src/client.js";
import type { InsightFilter } from "../../packages/contracts/src/student-insights.js";
import {
  addDays,
  resolveInsightRange,
} from "../../apps/server/src/modules/student-insights/metrics.js";
import {
  readInsightFacts,
  type InsightFacts,
} from "../../apps/server/src/modules/student-insights/facts.js";

async function factsFor(
  db: Database,
  studentId: string,
  filter: Partial<InsightFilter> = {},
): Promise<InsightFacts> {
  const range = resolveInsightRange(filter);
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const facts = await readInsightFacts(client, studentId, {
      from: range.from,
      to: range.to,
      revisionId: filter.revisionId,
    });
    await client.query("ROLLBACK");
    return facts;
  } finally {
    client.release();
  }
}

function rangeFor(seed: InsightFactsSeed): Partial<InsightFilter> {
  return { from: addDays(seed.today, -29), to: seed.today };
}

it("keeps the lifetime first attempt instead of an in-range redo", async () =>
  withTestDb(async (db) => {
    const fixture: StudentInsightsFixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const facts = await factsFor(db, fixture.studentA.studentId, rangeFor(seed));

    const firstForA = facts.firstAttempts.find(
      (row) => row.questionId === seed.questionA,
    );
    expect(firstForA?.attemptId).toBe(seed.attemptIds.firstA);

    // 首次作答在区间外：区间内的重做不能顶替它
    expect(
      facts.firstAttempts.some((row) => row.questionId === seed.questionB),
    ).toBe(false);
    expect(facts.attempts.map((row) => row.id)).toContain(
      seed.attemptIds.redoB,
    );
  }));

it("reads only the latest assessment for each attempt", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const facts = await factsFor(db, fixture.studentA.studentId, rangeFor(seed));

    const first = facts.attempts.find(
      (row) => row.id === seed.attemptIds.firstA,
    );
    expect(first?.assessment?.id).toBe(seed.assessmentIds.firstALatest);
    expect(first?.assessment?.correctness).toBe("correct");
    expect(
      facts.attempts.filter((row) => row.id === seed.attemptIds.firstA),
    ).toHaveLength(1);
  }));

it("excludes soft-deleted tasks and invalidated evidence", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const facts = await factsFor(db, fixture.studentA.studentId, rangeFor(seed));

    const ids = facts.attempts.map((row) => row.id);
    expect(ids).not.toContain(seed.attemptIds.deletedTask);
    expect(ids).not.toContain(seed.attemptIds.invalidatedQuestion);
    expect(ids).not.toContain(seed.attemptIds.invalidatedMessage);
    expect(ids).toHaveLength(5);
    expect(facts.tasks.map((row) => row.id)).not.toContain(seed.deletedTask);

    const knowledgeFacts = facts.knowledge.map((row) => row.fact as { kind: string });
    expect(knowledgeFacts.map((row) => row.kind)).not.toContain("stale");
    expect(knowledgeFacts.map((row) => row.kind)).not.toContain("invalidated");
    expect(knowledgeFacts.map((row) => row.kind).sort()).toEqual([
      "current",
      "unbound",
    ]);
  }));

it("does not multiply facts by question sources", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const facts = await factsFor(db, fixture.studentA.studentId, rangeFor(seed));

    expect(facts.questionSources).toHaveLength(2);
    expect(
      facts.questionSources.every(
        (row) => row.questionVersionId === seed.questionVersionA,
      ),
    ).toBe(true);
    expect(facts.attempts).toHaveLength(5);
  }));

it("separates revisions in every fact collection", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const facts = await factsFor(db, fixture.studentA.studentId, {
      ...rangeFor(seed),
      revisionId: seed.revisionA,
    });

    expect(facts.attempts.map((row) => row.id)).not.toContain(
      seed.attemptIds.revisionB,
    );
    expect(
      facts.firstAttempts.some((row) => row.questionId === seed.questionC),
    ).toBe(false);
    expect(facts.mistakes.map((row) => row.questionId)).toEqual([
      seed.questionA,
    ]);
    expect(
      facts.attempts.every((row) => row.revisionId === seed.revisionA),
    ).toBe(true);
  }));

it("surfaces pending verifications without folding them into facts", async () =>
  withTestDb(async (db) => {
    const fixture = await studentInsightsFixture(db);
    const seed = await seedInsightFacts(fixture);
    const facts = await factsFor(db, fixture.studentA.studentId, rangeFor(seed));

    const pending = facts.attempts.find(
      (row) => row.id === seed.attemptIds.pending,
    );
    expect(pending?.assessment).toEqual({
      id: seed.assessmentIds.pending,
      correctness: "unknown",
      verification: "pending",
      hintDependency: "none",
    });
    const verified = facts.attempts.filter(
      (row) => row.assessment?.verification === "verified",
    );
    expect(verified).toHaveLength(4);
  }));
