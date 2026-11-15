import { z } from "zod";
import { createDb } from "../packages/db/src/client.js";
import { AuthService } from "../apps/server/src/modules/auth/service.js";
import { MistakeService } from "../apps/server/src/modules/learning/mistakes.js";
import { backfillMistakes } from "../apps/server/src/modules/learning/mistake-backfill.js";

const usage = `用法：pnpm backfill:mistakes [选项]

默认 dry-run，只扫描并输出报告，不写入数据库。
  --apply              实际写入缺失的错题记录
  --student-id <uuid>  只处理指定学生
  --cursor <cursor>    从上一批的 nextCursor 继续
  --batch-size <n>     每批数量，1～500，默认 100
  --help               显示本说明

报告只包含计数、ID 与原因码，不包含学生作答或附件内容。`;

function parseArgs(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) throw Error(`未知参数：${arg}`);
    const [key, inline] = arg.slice(2).split("=");
    if (inline !== undefined) flags.set(key!, inline);
    else if (key === "apply" || key === "help") flags.set(key, true);
    else {
      const value = argv[index + 1];
      if (value === undefined) throw Error(`缺少参数值：--${key}`);
      flags.set(key!, value);
      index += 1;
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
if (flags.get("help") === true) {
  console.log(usage);
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) throw Error("缺少 DATABASE_URL");
const studentId = flags.get("student-id");
const cursor = flags.get("cursor");
const batchSize = flags.get("batch-size");
const database = createDb(url);
try {
  const report = await backfillMistakes(
    database,
    new MistakeService(database, new AuthService(database)),
    {
      ...(typeof studentId === "string" ? { studentId } : {}),
    },
    {
      apply: flags.get("apply") === true,
      ...(typeof cursor === "string" ? { cursor } : {}),
      ...(typeof batchSize === "string"
        ? { batchSize: z.coerce.number().int().min(1).max(500).parse(batchSize) }
        : {}),
    },
  );
  console.log(JSON.stringify(report));
} finally {
  await database.close();
}
