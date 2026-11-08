import { readFile } from "node:fs/promises";
import pg from "pg";
import { pgEnv, command, sha256 } from "./pg-process.mjs";
try {
  const url = process.env.RESTORE_DATABASE_URL,
    path = process.env.RESTORE_DUMP_PATH;
  if (!url || !path) throw Error("RESTORE_CONFIG_REQUIRED");
  if (url === process.env.DATABASE_URL)
    throw Error("PRODUCTION_TARGET_REFUSED");
  const env = pgEnv(url),
    name = env.PGDATABASE;
  if (
    !/^xy_tutor_restore_[a-z0-9_]+$/.test(name) ||
    process.env.RESTORE_CONFIRM_DATABASE !== name
  )
    throw Error("UNCONFIRMED_TARGET");
  const hash = await sha256(path);
  const expected =
    process.env.RESTORE_EXPECTED_SHA256 ||
    (await readFile(path + ".sha256", "utf8")).trim();
  if (hash !== expected) throw Error("CHECKSUM_MISMATCH");
  const admin = new pg.Client({
    connectionString: url.replace(/\/[^/?]+(\?.*)?$/, "/postgres$1"),
  });
  await admin.connect();
  try {
    const exists = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname=$1",
      [name],
    );
    if (exists.rowCount) throw Error("EXISTING_DATABASE_REFUSED");
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  await command(
    "pg_restore",
    ["--no-owner", "--no-acl", "--exit-on-error", `--dbname=${name}`, path],
    env,
  );
  console.log(
    "Restore complete in a newly created isolated database; validate before switching traffic",
  );
} catch {
  console.error(
    "DATABASE_RESTORE_FAILED: target must be new xy_tutor_restore_* with exact confirmation and valid checksum; a partial target is preserved for inspection",
  );
  process.exitCode = 1;
}
