import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createDb } from "../../packages/db/src/client.js";
import { migrateDatabase } from "../../packages/db/src/migrations.js";
import { catalogFixture } from "../helpers/catalog.js";
import { TaskService } from "../../apps/server/src/modules/learning/tasks.js";
import { MessageService } from "../../apps/server/src/modules/conversations/messages.js";
import { buildApp } from "../../apps/server/src/app.js";
const testUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://xy_tutor@127.0.0.1:55432/xy_tutor_test";
assert(new URL(testUrl).pathname.endsWith("_test"));
const base = new URL(testUrl);
base.pathname = "/postgres";
const admin = new pg.Client({ connectionString: base.toString() });
await admin.connect();
const suffix = randomUUID().replaceAll("-", "");
const sourceName = `xy_tutor_restore_source_${suffix}`,
  targetName = `xy_tutor_restore_target_${suffix}`;
const source = new URL(base),
  target = new URL(base);
source.pathname = "/" + sourceName;
target.pathname = "/" + targetName;
const dir = await mkdtemp(join(tmpdir(), "xy-restore-test-"));
const dump = join(dir, "test.dump");
const run = (script: string, env: Record<string, string>) =>
  new Promise<number>((resolve) => {
    const child = spawn("sh", [script], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    child.once("exit", (code) => {
      if (code) console.log(output.trim());
      resolve(code ?? 1);
    });
  });
const start = Date.now();
try {
  await admin.query(`CREATE DATABASE "${sourceName}"`);
  const db = createDb(source.toString());
  try {
    await migrateDatabase(db);
    const f = await catalogFixture(db);
    const r = await f.publish("人教版", "恢复验收教材");
    const t = await new TaskService(db, f.auth, f.catalog).create(f.scope, {
      revisionId: r.id,
      kind: "free_question",
    });
    await new MessageService(db, f.auth).append(f.scope, {
      conversationId: t.conversationId,
      role: "user",
      content: "恢复后仍可追溯",
    });
  } finally {
    await db.close();
  }
  assert.equal(
    await run("scripts/backup-db.sh", {
      DATABASE_URL: source.toString(),
      BACKUP_LOCAL_ONLY: "1",
      BACKUP_LOCAL_PATH: dump,
    }),
    0,
  );
  const env = {
    DATABASE_URL: source.toString(),
    RESTORE_DATABASE_URL: target.toString(),
    RESTORE_CONFIRM_DATABASE: targetName,
    RESTORE_DUMP_PATH: dump,
  };
  assert.equal(await run("scripts/restore-db.sh", env), 0);
  assert.notEqual(await run("scripts/restore-db.sh", env), 0);
  const restored = createDb(target.toString());
  try {
    for (const table of [
      "users",
      "student_profiles",
      "textbook_revisions",
      "learning_tasks",
      "messages",
      "message_versions",
    ]) {
      const count = (
        await restored.pool.query(`SELECT count(*)::int AS n FROM ${table}`)
      ).rows[0].n;
      assert(count > 0, table);
    }
    const rows = (
      await restored.pool.query(
        "SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN learning_tasks t ON t.id=c.task_id",
      )
    ).rows[0];
    assert.equal(rows.n, 1);
    const app = buildApp({
      database: restored,
      readiness: async () => {
        await restored.pool.query("SELECT 1");
      },
    });
    assert.equal((await app.inject("/api/health/ready")).statusCode, 200);
    await app.close();
  } finally {
    await restored.close();
  }
  console.log(
    `BACKUP_RESTORE_PASS local PG14, elapsed=${Date.now() - start}ms; OSS transfer and ECS RTO remain unverified`,
  );
} finally {
  for (const name of [sourceName, targetName])
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
  await rm(dir, { recursive: true, force: true });
}
