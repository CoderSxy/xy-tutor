import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { StudentScope } from "../../../../packages/contracts/src/domain.js";
import type { AssessmentService } from "../modules/learning/assessments.js";
import { enqueueJob } from "./queue.js";
import type { JobHandler } from "./runner.js";

export const assessmentJobPayloadSchema = z
  .object({
    attemptId: z.uuid(),
    studentId: z.uuid(),
    actorId: z.uuid(),
    taskId: z.uuid().optional(),
  })
  .strict();

export type AssessmentJobPayload = z.infer<typeof assessmentJobPayloadSchema>;

export async function enqueueAttemptAssessment(
  tx: Pool | PoolClient,
  input: AssessmentJobPayload,
): Promise<string> {
  return enqueueJob(tx, {
    kind: "learning.assess",
    dedupeKey: `learning.assess:${input.attemptId}`,
    payload: input,
  });
}

export function assessmentHandler(service: AssessmentService): JobHandler {
  return async (job, signal) => {
    const input = assessmentJobPayloadSchema.parse(job.payload);
    const scope: StudentScope = {
      actor: { userId: input.actorId, role: "student" },
      studentId: input.studentId,
    };
    const result = await service.assessAttempt(scope, input.attemptId, signal);
    return {
      assessmentId: result.id,
      correctness: result.correctness,
      verification: result.verification,
    };
  };
}
