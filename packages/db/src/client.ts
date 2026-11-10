import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
export function createDb(url: string, schema = "public") {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw Error("Invalid database schema");
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 3000,
    options: `-c search_path=${schema}`,
  });
  return { pool, db: drizzle(pool), schema, close: () => pool.end() };
}
export type Database = ReturnType<typeof createDb>;
export type Db = Database["db"];
export async function inTransaction<T>(
  c: Database,
  run: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const tx = await c.pool.connect();
  try {
    await tx.query("BEGIN");
    const value = await run(tx);
    await tx.query("COMMIT");
    return value;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
