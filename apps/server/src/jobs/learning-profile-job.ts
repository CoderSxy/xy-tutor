import { z } from "zod";
import type { LearningProfileService } from "../modules/learning-profile/service.js";
import type { JobHandler } from "./runner.js";

export function learningProfileRebuildHandler(
  service: LearningProfileService,
): JobHandler {
  return async (job) => {
    const payload = z
      .object({ studentId: z.uuid(), skillId: z.uuid() })
      .parse(job.payload);
    const profile = await service.rebuildSystem(
      payload.studentId,
      payload.skillId,
    );
    return {
      studentId: profile.studentId,
      skillId: profile.skillId,
      version: profile.version,
    };
  };
}
