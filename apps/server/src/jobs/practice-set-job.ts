import { z } from "zod";
import type { StudentScope } from "../../../../packages/contracts/src/domain.js";
import type { PracticeSetService } from "../modules/learning/practice-sets.js";
import type { JobHandler } from "./runner.js";

export const practiceSetJobPayloadSchema = z
  .object({
    setId: z.uuid(),
    studentId: z.uuid(),
    actorId: z.uuid(),
  })
  .strict();

export function practiceSetHandler(service: PracticeSetService): JobHandler {
  return async (job, signal) => {
    const input = practiceSetJobPayloadSchema.parse(job.payload);
    signal.throwIfAborted();
    const scope: StudentScope = {
      actor: { userId: input.actorId, role: "student" },
      studentId: input.studentId,
    };
    const dto = await service.generateAll(scope, input.setId);
    return { setId: dto.id, generation: dto.generation };
  };
}
