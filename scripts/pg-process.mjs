import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
export function pgEnv(url) {
  const u = new URL(url);
  if (!["postgres:", "postgresql:"].includes(u.protocol))
    throw Error("INVALID_DATABASE_URL");
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGSSLMODE: u.searchParams.get("sslmode") ?? "prefer",
  };
}
export function command(bin, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", () => reject(Error("PG_TOOL_UNAVAILABLE")));
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error("PG_COMMAND_FAILED")),
    );
  });
}

export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
