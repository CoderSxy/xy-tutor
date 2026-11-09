import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { SelectionService } from "../../apps/server/src/modules/learning/selections.js";
it("persists one recent selection per student grade and subject across service instances", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const a = await f.publish("人教版", "第一版本");
    const b = await f.publish("苏教版", "第二版本");
    const s = new SelectionService(db, f.auth);
    await s.record(f.scope, { revisionId: a.id });
    await s.record(f.scope, { revisionId: a.id });
    await s.record(f.scope, { revisionId: b.id });
    const history = await new SelectionService(db, f.auth).list(f.scope);
    expect(history).toHaveLength(1);
    expect(history[0]?.revisionId).toBe(b.id);
    expect(history[0]?.edition).toBe("苏教版");
    await f.catalog.disable(f.admin, b.id);
    expect((await s.list(f.scope))[0]?.status).toBe("disabled");
    await expect(s.record(f.scope, { revisionId: b.id })).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
  }));
it("orders recent subject selections and rejects foreign student access", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const a = await f.publish("人教版", "数学");
    const b = await f.publish("苏教版", "英语");
    const subject = (
      await db.pool.query(
        "INSERT INTO subjects(name) VALUES('英语') RETURNING id",
      )
    ).rows[0].id;
    await db.pool.query(
      "UPDATE textbooks SET subject_id=$1 WHERE id=(SELECT textbook_id FROM textbook_revisions WHERE id=$2)",
      [subject, b.id],
    );
    const s = new SelectionService(db, f.auth);
    await s.record(f.scope, { revisionId: a.id });
    await s.record(f.scope, { revisionId: b.id });
    await s.record(f.scope, { revisionId: a.id });
    expect((await s.list(f.scope)).map((r) => r.subject)).toEqual([
      "数学",
      "英语",
    ]);
    await expect(
      s.list({ ...f.scope, studentId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }));
