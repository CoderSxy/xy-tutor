import { withTestDb } from "./database.js";
export async function seedPracticeScope(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
  actorId: string,
) {
  const batchId = (
    await db.pool.query<{ id: string }>(
      "INSERT INTO knowledge_batches(actor_id) VALUES($1) RETURNING id",
      [actorId],
    )
  ).rows[0]!.id;
  const runId = (
    await db.pool.query<{ id: string }>(
      "INSERT INTO knowledge_parse_runs(batch_id,status) VALUES($1,'succeeded') RETURNING id",
      [batchId],
    )
  ).rows[0]!.id;
  const knowledge = await db.pool.query<{ id: string }>(
    `INSERT INTO knowledge_items(batch_id,parse_run_id,title,summary,status,published_at)
     VALUES($1,$2,'有理数','加减运算','published',now()) RETURNING id`,
    [batchId, runId],
  );
  const skill = (
    await db.pool.query<{ id: string }>(
      "INSERT INTO skills(code,name,created_by) VALUES('rational','有理数',$1) RETURNING id",
      [actorId],
    )
  ).rows[0]!.id;
  await db.pool.query(
    "INSERT INTO skill_content_links(skill_id,knowledge_item_id,created_by) VALUES($1,$2,$3)",
    [skill, knowledge.rows[0]!.id, actorId],
  );
  await db.pool.query(
    "INSERT INTO question_templates(family,skill_id,difficulty_band,status,approved_by,approved_at,created_by) VALUES('rational_arithmetic',$1,'easy','approved',$2,now(),$2)",
    [skill, actorId],
  );
  return skill;
}
