import { randomUUID } from "node:crypto";
import pg from "pg";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import { createDb, type Database } from "../../packages/db/src/client.js";

export const DEFAULT_TEST_DATABASE_URL =
  "postgres://xy_tutor@127.0.0.1:55432/xy_tutor_test";

/** Rejects any URL that could point at real data. */
export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    throw Error("Refusing unsafe test database");
  }
  if (
    env.NODE_ENV === "production" ||
    url === env.DATABASE_URL ||
    !pathname.endsWith("_test")
  )
    throw Error("Refusing unsafe test database");
  return url;
}

export async function withTestDb(
  run: (c: Database) => Promise<void>,
): Promise<void> {
  const url = resolveTestDatabaseUrl(process.env);
  const schema = "test_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const c = createDb(url, schema);
  try {
    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(
        new URL("../../packages/db/migrations/", import.meta.url),
      ),
    });
    for (const migration of migrations)
      for (const statement of migration.sql)
        await c.pool.query(statement.replaceAll('"public".', `"${schema}".`));
    await run(c);
  } finally {
    await c.close();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}
