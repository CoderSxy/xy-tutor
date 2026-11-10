import { it, expect } from "vitest";
import { withTestDb } from "../helpers/database.js";
import type { Database } from "../../packages/db/src/client.js";

async function seedStudent(c: Database, name = "学生甲") {
  return (
    await c.pool.query<{ id: string }>(
      "INSERT INTO student_profiles(display_name) VALUES($1) RETURNING id",
      [name],
    )
  ).rows[0]!.id;
}

it("deduplicates learning events by source key", async () => {
  await withTestDb(async (c) => {
    const studentId = await seedStudent(c);
    const sourceId = crypto.randomUUID();
    for (let i = 0; i < 2; i += 1)
      await c.pool.query(
        "INSERT INTO student_learning_events(student_id,event_type,source_type,source_id,occurred_at) VALUES($1,'answer_submitted','attempt',$2,'2026-11-01T00:00:00Z') ON CONFLICT DO NOTHING",
        [studentId, sourceId],
      );
    const rows = await c.pool.query(
      "SELECT count(*)::int AS n FROM student_learning_events",
    );
    expect(rows.rows[0].n).toBe(1);
  });
});

it("rejects invalid event status and missing student", async () => {
  await withTestDb(async (c) => {
    const studentId = await seedStudent(c);
    await expect(
      c.pool.query(
        "INSERT INTO student_learning_events(student_id,event_type,source_type,source_id,occurred_at) VALUES($1,'task_created','attempt',$2,'2026-11-01T00:00:00Z')",
        [studentId, crypto.randomUUID()],
      ),
    ).rejects.toThrow(/event_type_check/);
    await expect(
      c.pool.query(
        "INSERT INTO student_learning_events(student_id,event_type,source_type,source_id,occurred_at) VALUES($1,'answer_submitted','attempt',$2,'2026-11-01T00:00:00Z')",
        [crypto.randomUUID(), crypto.randomUUID()],
      ),
    ).rejects.toThrow(/student_id_student_profiles_id_fk/);
  });
});

it("upserts one visit row per student/day/timezone", async () => {
  await withTestDb(async (c) => {
    const studentId = await seedStudent(c);
    for (let i = 0; i < 3; i += 1)
      await c.pool.query(
        "INSERT INTO student_daily_visits(student_id,local_date) VALUES($1,'2026-11-10') ON CONFLICT(student_id,local_date,timezone) DO UPDATE SET last_seen_at=now()",
        [studentId],
      );
    const rows = await c.pool.query(
      "SELECT count(*)::int AS n FROM student_daily_visits WHERE student_id=$1",
      [studentId],
    );
    expect(rows.rows[0].n).toBe(1);
  });
});

it("keeps the collection split point stable across restarts", async () => {
  await withTestDb(async (c) => {
    const insert =
      "INSERT INTO student_insight_collection_state(id,learning_started_at,visits_started_at) VALUES(1,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z') ON CONFLICT(id) DO NOTHING";
    await c.pool.query(insert);
    await c.pool.query(insert);
    const rows = await c.pool.query(
      "SELECT learning_started_at,visits_started_at FROM student_insight_collection_state",
    );
    expect(rows.rows).toHaveLength(1);
    expect(new Date(rows.rows[0].learning_started_at).toISOString()).toBe(
      "2026-11-01T00:00:00.000Z",
    );
    await expect(
      c.pool.query(
        "INSERT INTO student_insight_collection_state(id) VALUES(2)",
      ),
    ).rejects.toThrow(/singleton/);
  });
});

it("keeps null revision reports unique per snapshot", async () => {
  await withTestDb(async (c) => {
    const studentId = await seedStudent(c);
    const adminId = (
      await c.pool.query<{ id: string }>(
        "INSERT INTO users(login,password_hash,role) VALUES('admin','x','admin') RETURNING id",
      )
    ).rows[0]!.id;
    const insert = (hash: string) =>
      c.pool.query(
        `INSERT INTO student_insight_reports(student_id,requested_by,from_date,to_date,metric_version,prompt_version,snapshot_hash,snapshot,evidence_catalog) VALUES($1,$2,'2026-11-01','2026-11-10','student-insights-v1','student-insight-report-v1',$3,'{}','[]')`,
        [studentId, adminId, hash],
      );
    await insert("same");
    await expect(insert("same")).rejects.toThrow(/snapshot_unique/);
    await insert("different");
    const rows = await c.pool.query(
      "SELECT count(*)::int AS n FROM student_insight_reports",
    );
    expect(rows.rows[0].n).toBe(2);
    await expect(
      c.pool.query(
        "INSERT INTO student_insight_reports(student_id,requested_by,from_date,to_date,metric_version,prompt_version,snapshot_hash,snapshot,evidence_catalog,status) VALUES($1,$2,'2026-11-01','2026-11-10','v','p','x','{}','[]','bogus')",
        [studentId, adminId],
      ),
    ).rejects.toThrow(/status_check/);
  });
});
