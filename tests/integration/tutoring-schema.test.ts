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

async function seedTask(c: Database, studentId: string) {
  return (
    await c.pool.query<{ id: string }>(
      "INSERT INTO learning_tasks(student_id,kind,title) VALUES($1,'practice','练习') RETURNING id",
      [studentId],
    )
  ).rows[0]!.id;
}

async function seedQuestionVersion(c: Database, studentId: string) {
  const questionId = (
    await c.pool.query<{ id: string }>(
      "INSERT INTO questions(student_id,source_type) VALUES($1,'generated') RETURNING id",
      [studentId],
    )
  ).rows[0]!.id;
  return (
    await c.pool.query<{ id: string }>(
      "INSERT INTO question_versions(question_id,version_no,stem) VALUES($1,1,'1+1=?') RETURNING id",
      [questionId],
    )
  ).rows[0]!.id;
}

async function seedMessageVersion(c: Database, studentId: string, taskId: string) {
  const conversationId = (
    await c.pool.query<{ id: string }>(
      "INSERT INTO conversations(student_id,task_id) VALUES($1,$2) RETURNING id",
      [studentId, taskId],
    )
  ).rows[0]!.id;
  const messageId = (
    await c.pool.query<{ id: string }>(
      "INSERT INTO messages(conversation_id,role) VALUES($1,'assistant') RETURNING id",
      [conversationId],
    )
  ).rows[0]!.id;
  return (
    await c.pool.query<{ id: string }>(
      "INSERT INTO message_versions(message_id,version_no,content) VALUES($1,1,'题目') RETURNING id",
      [messageId],
    )
  ).rows[0]!.id;
}

type Seed = {
  studentId: string;
  taskId: string;
  questionVersionId: string;
  messageVersionId: string;
};

async function seed(c: Database, name = "学生甲"): Promise<Seed> {
  const studentId = await seedStudent(c, name);
  const taskId = await seedTask(c, studentId);
  const questionVersionId = await seedQuestionVersion(c, studentId);
  const messageVersionId = await seedMessageVersion(c, studentId, taskId);
  return { studentId, taskId, questionVersionId, messageVersionId };
}

async function insertEpisode(
  c: Database,
  seed: Seed,
  requestKey: string,
  state = "active",
) {
  return (
    await c.pool.query<{ id: string }>(
      "INSERT INTO tutoring_episodes(student_id,task_id,question_version_id,request_key,state) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [seed.studentId, seed.taskId, seed.questionVersionId, requestKey, state],
    )
  ).rows[0]!.id;
}

it("allows only one open episode per student", async () => {
  await withTestDb(async (c) => {
    const s = await seed(c);
    await insertEpisode(c, s, "episode-1");
    await expect(insertEpisode(c, s, "episode-2")).rejects.toThrow(
      /tutoring_episode_active_lease/,
    );
    await insertEpisode(c, s, "episode-3", "finished");
    await c.pool.query(
      "UPDATE tutoring_episodes SET state='finished' WHERE request_key='episode-1'",
    );
    await insertEpisode(c, s, "episode-4");
    const rows = await c.pool.query(
      "SELECT count(*)::int AS n FROM tutoring_episodes",
    );
    expect(rows.rows[0].n).toBe(3);
  });
});

it("rejects invalid episode state, exposure, and counters", async () => {
  await withTestDb(async (c) => {
    const s = await seed(c);
    await expect(
      c.pool.query(
        "INSERT INTO tutoring_episodes(student_id,task_id,question_version_id,request_key,state) VALUES($1,$2,$3,'bad','abandoned')",
        [s.studentId, s.taskId, s.questionVersionId],
      ),
    ).rejects.toThrow(/tutoring_episode_state_check/);
    await expect(
      c.pool.query(
        "INSERT INTO tutoring_episodes(student_id,task_id,question_version_id,request_key,exposure) VALUES($1,$2,$3,'bad','shared')",
        [s.studentId, s.taskId, s.questionVersionId],
      ),
    ).rejects.toThrow(/tutoring_episode_exposure_check/);
    await expect(
      c.pool.query(
        "INSERT INTO tutoring_episodes(student_id,task_id,question_version_id,request_key,lease_epoch) VALUES($1,$2,$3,'bad',0)",
        [s.studentId, s.taskId, s.questionVersionId],
      ),
    ).rejects.toThrow(/tutoring_episode_positive_counters/);
  });
});

it("validates question and task references for episodes", async () => {
  await withTestDb(async (c) => {
    const s = await seed(c);
    const other = await seed(c, "学生乙");
    await expect(
      c.pool.query(
        "INSERT INTO tutoring_episodes(student_id,task_id,question_version_id,request_key) VALUES($1,$2,$3,'bad')",
        [s.studentId, s.taskId, crypto.randomUUID()],
      ),
    ).rejects.toThrow(/question_version_id_question_versions_id_fk/);
    await expect(
      c.pool.query(
        "INSERT INTO tutoring_episodes(student_id,task_id,question_version_id,request_key) VALUES($1,$2,$3,'bad')",
        [s.studentId, crypto.randomUUID(), s.questionVersionId],
      ),
    ).rejects.toThrow(/task_id_learning_tasks_id_fk/);
    // Cross-student task/question combinations are a service-level rule; the
    // database only guarantees that both rows exist.
    await c.pool.query(
      "INSERT INTO tutoring_episodes(student_id,task_id,question_version_id,request_key,state) VALUES($1,$2,$3,'foreign-task','finished')",
      [s.studentId, other.taskId, s.questionVersionId],
    );
  });
});

it("deduplicates timing events by event key and sequence", async () => {
  await withTestDb(async (c) => {
    const s = await seed(c);
    const episodeId = await insertEpisode(c, s, "episode-1");
    const event = {
      eventId: crypto.randomUUID(),
      segmentId: crypto.randomUUID(),
      seq: 1,
    };
    const insert = (values: typeof event) =>
      c.pool.query(
        `INSERT INTO timing_events(episode_id,event_id,seq,segment_id,lease_epoch,kind,cumulative_active_ms,accepted_ms,phase,payload_hash,received_at)
         VALUES($1,$2,$3,$4,1,'checkpoint',15000,15000,'initial','h','2026-11-13T00:00:15Z')`,
        [episodeId, values.eventId, values.seq, values.segmentId],
      );
    await insert(event);
    await expect(insert(event)).rejects.toThrow(/timing_event_key/);
    await expect(
      insert({ ...event, eventId: crypto.randomUUID() }),
    ).rejects.toThrow(/timing_event_seq/);
    await c.pool.query(
      `INSERT INTO timing_events(episode_id,event_id,seq,segment_id,lease_epoch,kind,cumulative_active_ms,accepted_ms,phase,payload_hash,received_at)
       VALUES($1,$2,2,$3,1,'checkpoint',30000,15000,'initial','h','2026-11-13T00:00:30Z')`,
      [episodeId, crypto.randomUUID(), crypto.randomUUID()],
    );
    const rows = await c.pool.query(
      "SELECT count(*)::int AS n FROM timing_events WHERE episode_id=$1",
      [episodeId],
    );
    expect(rows.rows[0].n).toBe(2);
  });
});

it("rejects negative and unknown timing evidence", async () => {
  await withTestDb(async (c) => {
    const s = await seed(c);
    const episodeId = await insertEpisode(c, s, "episode-1");
    const base =
      "INSERT INTO timing_events(episode_id,event_id,seq,segment_id,lease_epoch,kind,cumulative_active_ms,accepted_ms,phase,payload_hash,received_at) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'h','2026-11-13T00:00:00Z')";
    await expect(
      c.pool.query(base, [
        episodeId,
        crypto.randomUUID(),
        1,
        crypto.randomUUID(),
        "checkpoint",
        -1,
        0,
        "initial",
      ]),
    ).rejects.toThrow(/timing_event_non_negative/);
    await expect(
      c.pool.query(base, [
        episodeId,
        crypto.randomUUID(),
        1,
        crypto.randomUUID(),
        "checkpoint",
        0,
        0,
        "after_lunch",
      ]),
    ).rejects.toThrow(/timing_event_phase_check/);
    await expect(
      c.pool.query(base, [
        episodeId,
        crypto.randomUUID(),
        1,
        crypto.randomUUID(),
        "sync",
        0,
        0,
        "initial",
      ]),
    ).rejects.toThrow(/timing_event_kind_check/);
  });
});

it("keeps missing timing as null instead of zero", async () => {
  await withTestDb(async (c) => {
    const s = await seed(c);
    const attemptId = (
      await c.pool.query<{ id: string }>(
        "INSERT INTO attempts(student_id,task_id,question_version_id,message_version_id,request_key,answer) VALUES($1,$2,$3,$4,'attempt-1','1') RETURNING id",
        [s.studentId, s.taskId, s.questionVersionId, s.messageVersionId],
      )
    ).rows[0]!.id;
    await c.pool.query(
      "INSERT INTO attempt_timing_snapshots(attempt_id,first_attempt_ms,quality,reason_codes) VALUES($1,NULL,'missing','[\"not_collected\"]')",
      [attemptId],
    );
    const rows = await c.pool.query(
      "SELECT first_attempt_ms,total_active_ms,wall_ms FROM attempt_timing_snapshots WHERE attempt_id=$1",
      [attemptId],
    );
    expect(rows.rows[0]).toEqual({
      first_attempt_ms: null,
      total_active_ms: null,
      wall_ms: null,
    });
    await expect(
      c.pool.query(
        "INSERT INTO attempt_timing_snapshots(attempt_id,version,first_attempt_ms) VALUES($1,2,-5)",
        [attemptId],
      ),
    ).rejects.toThrow(/attempt_timing_snapshot_non_negative/);
    await expect(
      c.pool.query(
        "INSERT INTO attempt_timing_snapshots(attempt_id,version,quality) VALUES($1,2,'guessed')",
        [attemptId],
      ),
    ).rejects.toThrow(/attempt_timing_snapshot_quality_check/);
  });
});

it("keeps old answers writable without timing or episodes", async () => {
  await withTestDb(async (c) => {
    const s = await seed(c);
    await c.pool.query(
      "INSERT INTO attempts(student_id,task_id,question_version_id,message_version_id,request_key,answer) VALUES($1,$2,$3,$4,'legacy-1','42')",
      [s.studentId, s.taskId, s.questionVersionId, s.messageVersionId],
    );
    await c.pool.query(
      "INSERT INTO attempts(student_id,task_id,question_version_id,message_version_id,request_key,answer) VALUES($1,$2,$3,$4,'legacy-1','42') ON CONFLICT DO NOTHING",
      [s.studentId, s.taskId, s.questionVersionId, s.messageVersionId],
    );
    const rows = await c.pool.query(
      "SELECT count(*)::int AS n FROM attempts WHERE student_id=$1",
      [s.studentId],
    );
    expect(rows.rows[0].n).toBe(1);
  });
});

it("appends diagnosis versions without overwriting", async () => {
  await withTestDb(async (c) => {
    const s = await seed(c);
    const attemptId = (
      await c.pool.query<{ id: string }>(
        "INSERT INTO attempts(student_id,task_id,question_version_id,message_version_id,request_key,answer) VALUES($1,$2,$3,$4,'attempt-1','1') RETURNING id",
        [s.studentId, s.taskId, s.questionVersionId, s.messageVersionId],
      )
    ).rows[0]!.id;
    const insert = (version: number, code: string) =>
      c.pool.query(
        `INSERT INTO error_diagnoses(attempt_id,question_version_id,version,status,primary_code,summary,rule_version)
         VALUES($1,$2,$3,'confirmed',$4,'摘要','diagnosis-v1') RETURNING id`,
        [attemptId, s.questionVersionId, version, code],
      );
    const first = (await insert(1, "concept_gap")).rows[0]!.id;
    await expect(insert(1, "rule_misuse")).rejects.toThrow(
      /error_diagnosis_version/,
    );
    const second = (await insert(2, "rule_misuse")).rows[0]!.id;
    expect(second).not.toBe(first);
    const rows = await c.pool.query(
      "SELECT version,primary_code FROM error_diagnoses WHERE attempt_id=$1 ORDER BY version",
      [attemptId],
    );
    expect(rows.rows).toEqual([
      { version: 1, primary_code: "concept_gap" },
      { version: 2, primary_code: "rule_misuse" },
    ]);
    await expect(insert(3, "careless")).rejects.toThrow(
      /error_diagnosis_primary_code_check/,
    );
  });
});

it("scopes tutoring actions and self-check rounds per episode", async () => {
  await withTestDb(async (c) => {
    const s = await seed(c);
    const episodeId = await insertEpisode(c, s, "episode-1");
    const insertAction = (requestKey: string) =>
      c.pool.query(
        "INSERT INTO tutoring_actions(episode_id,request_key,payload_hash,kind,state_version,state,exposure) VALUES($1,$2,'h','request_hint',1,'self_check','none') RETURNING id",
        [episodeId, requestKey],
      );
    await insertAction("hint-1");
    await expect(insertAction("hint-1")).rejects.toThrow(
      /tutoring_action_request_key/,
    );
    const insertRound = (roundNo: number) =>
      c.pool.query(
        "INSERT INTO self_check_outcomes(episode_id,round_no,outcome) VALUES($1,$2,'resolved')",
        [episodeId, roundNo],
      );
    await insertRound(1);
    await expect(insertRound(1)).rejects.toThrow(/self_check_outcome_round/);
    await expect(
      c.pool.query(
        "INSERT INTO self_check_outcomes(episode_id,round_no,outcome) VALUES($1,2,'skipped')",
        [episodeId],
      ),
    ).rejects.toThrow(/self_check_outcome_check/);
  });
});
