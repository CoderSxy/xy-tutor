import { z } from "zod";
import type { JobHandler } from "./runner.js";
import type { InsightReportGenerator } from "../modules/student-insights/report-generator.js";

const payload = z
  .object({ reportId: z.uuid(), generation: z.number().int().positive() })
  .strict();

export function studentInsightHandler(
  generator: InsightReportGenerator,
): JobHandler {
  return async (job, signal) => {
    payload.parse(job.payload);
    await generator.generate(job, signal);
    return { ok: true };
  };
}
