import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OSS from "ali-oss";
import { pgEnv, command, sha256 } from "./pg-process.mjs";
let temp;
try {
  if (!process.env.DATABASE_URL) throw Error("DATABASE_URL_REQUIRED");
  temp = await mkdtemp(join(tmpdir(), "xy-backup-"));
  const name = `${new Date().toISOString().slice(0, 10)}.dump`;
  const path = join(temp, name);
  await command(
    "pg_dump",
    ["--format=custom", "--no-owner", "--no-acl", `--file=${path}`],
    pgEnv(process.env.DATABASE_URL),
  );
  await chmod(path, 0o600);
  const hash = await sha256(path);
  if (process.env.BACKUP_LOCAL_ONLY === "1") {
    if (!process.env.BACKUP_LOCAL_PATH) throw Error("LOCAL_PATH_REQUIRED");
    const { copyFile } = await import("node:fs/promises");
    await copyFile(path, process.env.BACKUP_LOCAL_PATH);
    await chmod(process.env.BACKUP_LOCAL_PATH, 0o600);
    await writeFile(process.env.BACKUP_LOCAL_PATH + ".sha256", hash, {
      mode: 0o600,
    });
    console.log("Local test backup complete");
  } else {
    for (const k of ["REGION", "BUCKET", "ACCESS_KEY_ID", "ACCESS_KEY_SECRET"])
      if (!process.env[`BACKUP_OSS_${k}`])
        throw Error("BACKUP_OSS_CONFIG_REQUIRED");
    const client = new OSS({
      region: process.env.BACKUP_OSS_REGION,
      bucket: process.env.BACKUP_OSS_BUCKET,
      accessKeyId: process.env.BACKUP_OSS_ACCESS_KEY_ID,
      accessKeySecret: process.env.BACKUP_OSS_ACCESS_KEY_SECRET,
      secure: true,
    });
    const prefix = process.env.BACKUP_OSS_PREFIX || "xy-tutor/database";
    if (!/^[a-zA-Z0-9/_-]+$/.test(prefix)) throw Error("INVALID_PREFIX");
    const key = `${prefix}/${name}`;
    await client.put(key, path, { headers: { "x-oss-meta-sha256": hash } });
    const head = await client.head(key);
    if (head.meta?.sha256 !== hash) throw Error("BACKUP_VERIFY_FAILED");
    const listed = [];
    let marker;
    do {
      const page = await client.list(
        { prefix: prefix + "/", marker, "max-keys": 1000 },
        {},
      );
      for (const object of page.objects ?? [])
        if (
          new RegExp("^" + prefix + "/\\d{4}-\\d{2}-\\d{2}\\.dump$").test(
            object.name,
          )
        )
          listed.push(object.name);
      marker = page.isTruncated ? page.nextMarker : undefined;
    } while (marker);
    const stale = listed.sort().reverse().slice(7);
    if (stale.length) await client.deleteMulti(stale);
    console.log("Private OSS backup verified; retained 7 daily versions");
  }
} catch {
  console.error(
    "DATABASE_BACKUP_FAILED: check private configuration, pg_dump version and storage permissions",
  );
  if (process.env.BACKUP_ALERT_URL) {
    try {
      const u = new URL(process.env.BACKUP_ALERT_URL);
      if (u.protocol === "https:")
        await fetch(u, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event: "xy_tutor_database_backup_failed" }),
          signal: AbortSignal.timeout(10000),
        });
    } catch {
      /* cron must also alert on non-zero exit */
    }
  }
  process.exitCode = 1;
} finally {
  if (temp) await rm(temp, { recursive: true, force: true });
}
