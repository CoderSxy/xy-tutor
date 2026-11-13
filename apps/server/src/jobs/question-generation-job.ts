import { z } from "zod";
import type { QuestionGenerationService } from "../modules/question-bank/generator.js";
import type { JobHandler } from "./runner.js";

export function questionGenerationHandler(
  service: QuestionGenerationService,
): JobHandler {
  return async (job, signal) => {
    const runId = z
      .object({ runId: z.uuid() })
      .parse(job.payload).runId;
    return service.generate(runId, signal);
  };
}
