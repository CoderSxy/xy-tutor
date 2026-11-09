import { z } from "zod";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { AuthService } from "../auth/service.js";
export type SelectionDTO = {
  revisionId: string;
  grade: string;
  subject: string;
  edition: string;
  term: string;
  title: string;
  publicationYear: number;
  revisionNo: number;
  status: string;
  selectedAt: string;
};
export class SelectionService {
  constructor(
    private db: Database,
    private auth: AuthService,
  ) {}
  async list(scope: StudentScope): Promise<SelectionDTO[]> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    return (
      await this.db.pool.query<SelectionDTO>(
        `SELECT h.revision_id AS "revisionId",g.name AS grade,s.name AS subject,e.name AS edition,t.term,t.title,t.publication_year AS "publicationYear",r.revision_no AS "revisionNo",r.status,h.selected_at AS "selectedAt" FROM student_selections h JOIN textbook_revisions r ON r.id=h.revision_id JOIN textbooks t ON t.id=r.textbook_id JOIN grades g ON g.id=h.grade_id JOIN subjects s ON s.id=h.subject_id JOIN curriculum_editions e ON e.id=t.edition_id WHERE h.student_id=$1 ORDER BY h.selected_at DESC,h.id`,
        [scope.studentId],
      )
    ).rows;
  }
  async record(scope: StudentScope, input: unknown): Promise<SelectionDTO[]> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const { revisionId } = z
      .object({ revisionId: z.uuid() })
      .strict()
      .parse(input);
    await inTransaction(this.db, async (tx) => {
      const r = (
        await tx.query(
          "SELECT r.status,t.grade_id,t.subject_id FROM textbook_revisions r JOIN textbooks t ON t.id=r.textbook_id WHERE r.id=$1 FOR SHARE OF r",
          [revisionId],
        )
      ).rows[0];
      if (!r) throw new AppError("NOT_FOUND", 404, "教材不存在");
      if (r.status !== "published")
        throw new AppError("CONFLICT", 409, "教材已停用，请重新选择已发布教材");
      await tx.query(
        "INSERT INTO student_selections(student_id,grade_id,subject_id,revision_id) VALUES($1,$2,$3,$4) ON CONFLICT(student_id,grade_id,subject_id) DO UPDATE SET revision_id=EXCLUDED.revision_id,selected_at=clock_timestamp()",
        [scope.studentId, r.grade_id, r.subject_id, revisionId],
      );
    });
    return this.list(scope);
  }
}
