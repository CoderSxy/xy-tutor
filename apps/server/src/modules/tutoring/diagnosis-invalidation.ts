type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null }>;
};

/**
 * Marks diagnoses that relied on an edited message or corrected question as
 * invalidated. The original diagnosis and answer stay untouched; callers use
 * this inside their own transaction so the flag lands with the edit.
 */
export async function invalidateDiagnosesForEvidence(
  client: Queryable,
  studentId: string,
  evidenceVersionId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE error_diagnoses d
     SET status='invalidated',invalidated_at=now(),invalid_reason=$3
     FROM attempts a
     WHERE a.id=d.attempt_id AND a.student_id=$1 AND d.status<>'invalidated'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(d.evidence) ref
         WHERE ref->>'id'=$2 OR ref->>'versionId'=$2
       )`,
    [studentId, evidenceVersionId, reason],
  );
}
