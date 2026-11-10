import { createDb } from "../packages/db/src/client.js";
import { backfillStudentInsights } from "../apps/server/src/modules/student-insights/backfill.js";

function parseArgs(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) throw Error(`未知参数：${arg}`);
    const [key, inline] = arg.slice(2).split("=");
    if (inline !== undefined) flags.set(key!, inline);
    else if (key === "dry-run" || key === "no-resume") flags.set(key, true);
    else {
      const value = argv[index + 1];
      if (value === undefined) throw Error(`缺少参数值：--${key}`);
      flags.set(key!, value);
      index += 1;
    }
  }
  return flags;
}

const url = process.env.DATABASE_URL;
if (!url) throw Error("缺少 DATABASE_URL");
const flags = parseArgs(process.argv.slice(2));
const from = flags.get("from");
const to = flags.get("to");
if (typeof from !== "string" || typeof to !== "string")
  throw Error("必须提供 --from 与 --to（YYYY-MM-DD）");
const batchSize = flags.get("batch-size");

const database = createDb(url);
try {
  const result = await backfillStudentInsights(database, {
    from,
    to,
    batchSize: typeof batchSize === "string" ? Number(batchSize) : undefined,
    dryRun: flags.get("dry-run") === true,
    resume: flags.get("no-resume") !== true,
  });
  console.log(JSON.stringify(result));
} finally {
  await database.close();
}
