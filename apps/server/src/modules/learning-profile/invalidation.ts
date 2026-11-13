import type { Pool, PoolClient } from "pg";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";

export const PROFILE_REBUILD_JOB = "learning_profile.rebuild";

export function profileRebuildDedupeKey(
  studentId: string,
  skillId: string,
  evidenceVersionId: string,
): string {
  return `${PROFILE_REBUILD_JOB}:${studentId}:${skillId}:${evidenceVersionId}`;
}

export async function invalidateDerivedEvidence(
  tx: Pool | PoolClient,
  scope: StudentScope,
  evidenceVersionId: string,
  reason: string,
): Promise<string[]> {
  const skills = (
    await tx.query(
      `SELECT DISTINCT l.skill_id
         FROM attempts a
         JOIN question_bank_entries b ON b.question_version_id = a.question_version_id
         JOIN question_skill_links l ON l.entry_id = b.id AND l.is_primary
        WHERE a.student_id = $1
          AND (a.question_version_id = $2 OR a.message_version_id = $2)`,
      [scope.studentId, evidenceVersionId],
    )
  ).rows.map((row) => row.skill_id as string);
  if (skills.length === 0) return [];
  await tx.query(
    `UPDATE learning_profiles SET stale=true, updated_at=now()
      WHERE student_id=$1 AND skill_id = ANY($2::uuid[])`,
    [scope.studentId, skills],
  );
  for (const skillId of skills) {
    await tx.query(
      `INSERT INTO jobs(kind,dedupe_key,payload) VALUES($1,$2,$3)
       ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key`,
      [
        PROFILE_REBUILD_JOB,
        profileRebuildDedupeKey(scope.studentId, skillId, evidenceVersionId),
        JSON.stringify({
          studentId: scope.studentId,
          skillId,
          evidenceVersionId,
          reason,
        }),
      ],
    );
  }
  return skills;
}
