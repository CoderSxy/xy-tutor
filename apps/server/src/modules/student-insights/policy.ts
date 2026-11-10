import type { PoolClient } from "pg";
import { z } from "zod";
import type { Actor } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { AdminInsightScope } from "../../../../../packages/contracts/src/student-insights.js";
import type { Database } from "../../../../../packages/db/src/client.js";
import { requireAdmin } from "../auth/policy.js";

export async function requireAdminInsightScope(
  c: Database,
  actor: Actor,
  studentId: string,
): Promise<AdminInsightScope> {
  requireAdmin(actor);
  z.uuid().parse(studentId);
  const row = await c.pool.query(
    "SELECT 1 FROM student_profiles WHERE id=$1",
    [studentId],
  );
  if (!row.rowCount) throw new AppError("NOT_FOUND", 404, "学生不存在");
  return { actor, studentId };
}

export async function auditInsight(
  tx: PoolClient,
  scope: AdminInsightScope,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    "INSERT INTO audit_events(actor_id,student_id,action,details) VALUES($1,$2,$3,$4)",
    [scope.actor.userId, scope.studentId, action, JSON.stringify(details)],
  );
}
