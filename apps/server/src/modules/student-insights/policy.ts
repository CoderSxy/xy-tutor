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
  if (!z.uuid().safeParse(studentId).success)
    throw new AppError("VALIDATION", 422, "学生 ID 不正确");
  const row = await c.pool.query(
    "SELECT 1 FROM student_profiles WHERE id=$1",
    [studentId],
  );
  if (!row.rowCount) throw new AppError("NOT_FOUND", 404, "学生不存在");
  return { actor, studentId };
}

const VIEW_ACTIONS: Record<string, string> = {
  "student_insight.task_view": "taskId",
  "student_insight.material_view": "materialId",
};

// 前端轮询或翻页会重复请求同一详情，一分钟内同一资源的打开只记一次审计。
export async function auditInsight(
  tx: PoolClient,
  scope: AdminInsightScope,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  const resourceKey = VIEW_ACTIONS[action];
  const resourceId = resourceKey ? details[resourceKey] : undefined;
  if (resourceKey && typeof resourceId === "string") {
    await tx.query(
      `INSERT INTO audit_events(actor_id,student_id,action,details)
       SELECT $1,$2,$3,$4
       WHERE NOT EXISTS (
         SELECT 1 FROM audit_events
         WHERE actor_id=$1 AND student_id=$2 AND action=$3
           AND details->>$5 = $6
           AND created_at > now() - interval '60 seconds'
       )`,
      [
        scope.actor.userId,
        scope.studentId,
        action,
        JSON.stringify(details),
        resourceKey,
        resourceId,
      ],
    );
    return;
  }
  await tx.query(
    "INSERT INTO audit_events(actor_id,student_id,action,details) VALUES($1,$2,$3,$4)",
    [scope.actor.userId, scope.studentId, action, JSON.stringify(details)],
  );
}
