import { z } from "zod";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { MistakeService } from "./mistakes.js";
export class CorrectionService {
  constructor(private mistakes: MistakeService) {}
  async invalidate(
    scope: StudentScope,
    input: { evidenceId: string; reason: string },
  ) {
    const v = z
      .object({ evidenceId: z.uuid(), reason: z.string().min(1).max(1000) })
      .strict()
      .parse(input);
    await this.mistakes.auth.requireStudentAccess(scope.actor, scope.studentId);
    const match = await this.mistakes.db.pool.query(
      "SELECT 1 FROM message_versions v JOIN messages m ON m.id=v.message_id JOIN conversations c ON c.id=m.conversation_id WHERE v.id=$1 AND c.student_id=$2 UNION ALL SELECT 1 FROM question_versions v JOIN questions q ON q.id=v.question_id WHERE v.id=$1 AND q.student_id=$2",
      [v.evidenceId, scope.studentId],
    );
    if (!match.rowCount) throw new AppError("NOT_FOUND", 404, "证据不存在");
    await this.mistakes.db.pool.query(
      "INSERT INTO evidence_invalidations(student_id,evidence_version_id,reason) VALUES($1,$2,$3)",
      [scope.studentId, v.evidenceId, v.reason],
    );
    await this.mistakes.rebuild(scope);
  }
}
