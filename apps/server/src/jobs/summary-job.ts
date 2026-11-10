import { z } from "zod";
import type { JobHandler } from "./runner.js";
import type { SummaryService } from "../modules/learning/summaries.js";
export function summaryHandler(service: SummaryService): JobHandler {
  return async (job) => {
    const input = z.object({ taskId: z.uuid() }).parse(job.payload);
    await service.generate(input);
    return { ok: true };
  };
}
