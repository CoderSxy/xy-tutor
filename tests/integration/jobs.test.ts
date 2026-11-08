import { catalogFixture } from "../helpers/catalog.js";
import { JobRunner } from "../../apps/server/src/jobs/runner.js";
import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { JobQueue } from "../../apps/server/src/jobs/queue.js";
it("deduplicates jobs and rejects completion by an expired lease", async () =>
  withTestDb(async (db) => {
    const q = new JobQueue(db);
    const input = {
      kind: "parse",
      dedupeKey: "file-1",
      payload: { fileId: "one" },
    };
    const first = await q.enqueue(db.pool, input);
    expect(await q.enqueue(db.pool, input)).toBe(first);
    const now = new Date(Date.now() + 1000);
    const job = await q.claim("worker-a", now);
    expect(job?.id).toBe(first);
    expect(await q.claim("worker-b", now)).toBeNull();
    const recovered = await q.claim(
      "worker-b",
      new Date(now.getTime() + 31000),
    );
    expect(recovered?.id).toBe(first);
    expect(await q.finish(first, job!.leaseToken, { ok: true })).toBe(false);
    expect(await q.finish(first, recovered!.leaseToken, { ok: true })).toBe(
      true,
    );
  }));
it("stops retrying after three failed attempts", async () =>
  withTestDb(async (db) => {
    const q = new JobQueue(db);
    await q.enqueue(db.pool, {
      kind: "parse",
      dedupeKey: "file-2",
      payload: {},
    });
    let now = new Date(Date.now() + 1000);
    for (let i = 0; i < 3; i++) {
      const j = await q.claim("worker", now);
      expect(j).not.toBeNull();
      await q.fail(j!.id, j!.leaseToken, "PARSE_FAILED", now);
      now = new Date(now.getTime() + 60000);
    }
    expect(await q.claim("worker", now)).toBeNull();
    expect(
      (await db.pool.query("SELECT status FROM jobs")).rows[0].status,
    ).toBe("failed");
  }));
it("runs at most one background job even when ticks overlap", async () =>
  withTestDb(async (db) => {
    const { JobRunner } = await import("../../apps/server/src/jobs/runner.js");
    const q = new JobQueue(db);
    await q.enqueue(db.pool, { kind: "work", dedupeKey: "one", payload: {} });
    await q.enqueue(db.pool, { kind: "work", dedupeKey: "two", payload: {} });
    await db.pool.query(
      "UPDATE jobs SET available_at=now()-interval '1 second'",
    );
    let active = 0,
      max = 0;
    const runner = new JobRunner(q, {
      work: async () => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
        return { ok: true };
      },
    });
    await Promise.all([runner.tick(), runner.tick(), runner.tick()]);
    expect(max).toBe(1);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM jobs WHERE status='completed'",
        )
      ).rows[0].n,
    ).toBe(1);
  }));
it("waits for an active parsing job before shutdown closes its database", async () =>
  withTestDb(async (db) => {
    const q = new JobQueue(db);
    await q.enqueue(db.pool, {
      kind: "drain-test",
      dedupeKey: "drain",
      payload: {},
    });
    await db.pool.query(
      "UPDATE jobs SET available_at=now()-interval '1 second'",
    );
    let entered!: () => void;
    const ready = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    const runner = new JobRunner(q, {
      "drain-test": async () => {
        entered();
        await pending;
        return { ok: true };
      },
    });
    const tick = runner.tick();
    await ready;
    let stopped = false;
    const stop = Promise.resolve(runner.stop()).then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe(false);
    release();
    await Promise.all([tick, stop]);
    expect(
      (await db.pool.query("SELECT status FROM jobs")).rows[0].status,
    ).toBe("completed");
  }));
it("marks a crashed third attempt failed instead of leaving it running forever", async () =>
  withTestDb(async (db) => {
    const q = new JobQueue(db);
    const id = await q.enqueue(db.pool, {
      kind: "parse",
      dedupeKey: "crashed-third",
      payload: {},
    });
    await db.pool.query(
      "UPDATE jobs SET status='running',attempts=3,lease_token=gen_random_uuid(),lease_expires_at=now()-interval '1 minute' WHERE id=$1",
      [id],
    );
    expect(await q.claim("replacement", new Date())).toBeNull();
    expect(
      (await db.pool.query("SELECT status FROM jobs WHERE id=$1", [id])).rows[0]
        .status,
    ).toBe("failed");
  }));

it("repairs a processing textbook after its final lease crashes", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "故障恢复");
    await db.pool.query(
      "UPDATE textbook_revisions SET status='processing' WHERE id=$1",
      [r.id],
    );
    const q = new JobQueue(db);
    const id = await q.enqueue(db.pool, {
      kind: "textbook.parse",
      dedupeKey: "textbook:" + r.id,
      payload: { revisionId: r.id },
    });
    await db.pool.query(
      "UPDATE jobs SET status='running',attempts=3,lease_token=gen_random_uuid(),lease_expires_at=now()-interval '1 minute' WHERE id=$1",
      [id],
    );
    await q.claim("replacement", new Date());
    expect((await f.catalog.getRevision(f.admin, r.id)).status).toBe("failed");
  }));
it("retains safe parser error codes instead of hiding the cause", async () =>
  withTestDb(async (db) => {
    const q = new JobQueue(db);
    await q.enqueue(db.pool, {
      kind: "parse",
      dedupeKey: "page-limit",
      payload: {},
    });
    await db.pool.query(
      "UPDATE jobs SET available_at=now()-interval '1 second'",
    );
    const runner = new JobRunner(q, {
      parse: async () => {
        throw Error("PDF_PAGE_LIMIT");
      },
    });
    await runner.tick();
    expect(
      (await db.pool.query("SELECT error_code FROM jobs")).rows[0].error_code,
    ).toBe("PDF_PAGE_LIMIT");
  }));
