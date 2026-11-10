import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import type { Database } from "./client.js";
export async function migrateDatabase(c: Database): Promise<void> {
  await migrate(c.db, {
    migrationsFolder: fileURLToPath(new URL("../migrations/", import.meta.url)),
    migrationsSchema: c.schema,
  });
}
