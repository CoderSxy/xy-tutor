import { z } from "zod";
import type { StudentScope } from "../../../../packages/contracts/src/domain.js";
import type { MistakeService } from "../modules/learning/mistakes.js";
import { refreshPracticeSetState } from "../modules/learning/practice-progress.js";
import type { JobHandler } from "./runner.js";

export const mistakeSyncJobPayloadSchema = z
  .object({
    assessmentId: z.uuid(),
    studentId: z.uuid(),
    actorId: z.uuid(),
  })
  .strict();

export function mistakeSyncHandler(service: MistakeService): JobHandler {
  return async (job) => {
    const input = mistakeSyncJobPayloadSchema.parse(job.payload);
    const scope: StudentScope = {
      actor: { userId: input.actorId, role: "student" },
      studentId: input.studentId,
    };
    const assessment = (
      await service.db.pool.query(
        `SELECT s.id,s.attempt_id,s.correctness,s.verification,a.id AS attempt_id
         FROM assessments s JOIN attempts a ON a.id=s.attempt_id
         WHERE s.id=$1 AND a.student_id=$2`,
        [input.assessmentId, input.studentId],
      )
    ).rows[0];
    if (!assessment) return { status: "missing" };
    const latest = (
      await service.db.pool.query(
        `SELECT id,correctness,verification FROM assessments
         WHERE attempt_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
        [assessment.attempt_id],
      )
    ).rows[0];
    if (!latest || latest.id !== assessment.id)
      return { status: "stale", assessmentId: assessment.id };
    // applyAssessment always rebuilds the projection, so a later correct
    // assessment can revoke an earlier mistake even when it creates no new one.
    const mistake = await service.applyAssessment(scope, latest.id);
    const shouldSyncMistake =
      latest.verification === "verified" && latest.correctness === "incorrect";
    await service.db.pool.query(
      `UPDATE practice_submission_items
       SET grading_state=$3,
           mistake_sync_state=$4,
           latest_assessment_id=$1,
           reason_code=NULL,
           updated_at=now()
       WHERE attempt_id=$2 AND state='submitted'`,
      [
        latest.id,
        assessment.attempt_id,
        latest.verification === "verified" ? "verified" : "pending",
        shouldSyncMistake ? "synced" : "not_required",
      ],
    );
    const set = (
      await service.db.pool.query<{ id: string }>(
        `SELECT s.id FROM practice_submission_items i
         JOIN practice_set_slots sl ON sl.task_item_id=i.task_item_id
         JOIN practice_sets s ON s.id=sl.set_id
         WHERE i.attempt_id=$1 LIMIT 1`,
        [assessment.attempt_id],
      )
    ).rows[0];
    if (set) await refreshPracticeSetState(service.db.pool, set.id);
    return {
      status: shouldSyncMistake ? "synced" : "not_required",
      assessmentId: latest.id,
      ...(mistake ? { mistakeId: mistake.id } : {}),
    };
  };
}
