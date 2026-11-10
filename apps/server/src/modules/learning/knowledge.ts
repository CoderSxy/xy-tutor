import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import type { Database } from "../../../../../packages/db/src/client.js";
import type { AuthService } from "../auth/service.js";
export class KnowledgeService {
  constructor(
    private db: Database,
    private auth: AuthService,
  ) {}
  async get(scope: StudentScope, revisionId: string) {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const facts = (
      await this.db.pool.query(
        "SELECT DISTINCT ON(a.id) a.id AS attempt_id,s.id AS assessment_id,s.correctness,s.verification,s.hint_dependency,v.knowledge_point FROM attempts a JOIN question_versions v ON v.id=a.question_version_id JOIN questions q ON q.id=v.question_id LEFT JOIN assessments s ON s.attempt_id=a.id WHERE a.student_id=$1 AND q.revision_id=$2 AND NOT EXISTS(SELECT 1 FROM evidence_invalidations i WHERE i.student_id=a.student_id AND (i.evidence_version_id=a.question_version_id OR i.evidence_version_id=a.message_version_id)) ORDER BY a.id,s.created_at DESC,s.id DESC",
        [scope.studentId, revisionId],
      )
    ).rows;
    const stats = new Map<
      string,
      {
        knowledgePoint: string;
        correct: number;
        incorrect: number;
        pending: number;
        independentCorrect: number;
        assessmentIds: string[];
      }
    >();
    for (const f of facts) {
      const point = f.knowledge_point ?? "未标注";
      const s: {
        knowledgePoint: string;
        correct: number;
        incorrect: number;
        pending: number;
        independentCorrect: number;
        assessmentIds: string[];
      } = stats.get(point) ?? {
        knowledgePoint: point,
        correct: 0,
        incorrect: 0,
        pending: 0,
        independentCorrect: 0,
        assessmentIds: [],
      };
      if (f.verification === "verified" && f.correctness === "correct") {
        s.correct++;
        if (f.hint_dependency === "none") s.independentCorrect++;
      } else if (f.verification === "verified" && f.correctness === "incorrect")
        s.incorrect++;
      else s.pending++;
      if (f.assessment_id) s.assessmentIds.push(f.assessment_id);
      stats.set(point, s);
      if (f.assessment_id)
        await this.db.pool.query(
          "INSERT INTO knowledge_observations(student_id,revision_id,assessment_id,knowledge_point,fact) VALUES($1,$2,$3,$4,$5) ON CONFLICT(assessment_id) DO NOTHING",
          [
            scope.studentId,
            revisionId,
            f.assessment_id,
            point,
            JSON.stringify({
              correctness: f.correctness,
              verification: f.verification,
              hintDependency: f.hint_dependency,
            }),
          ],
        );
    }
    for (const s of stats.values())
      await this.db.pool.query(
        "INSERT INTO student_knowledge_states(student_id,revision_id,knowledge_point,evidence_stats) VALUES($1,$2,$3,$4) ON CONFLICT(student_id,revision_id,knowledge_point) DO UPDATE SET evidence_stats=EXCLUDED.evidence_stats,updated_at=now()",
        [scope.studentId, revisionId, s.knowledgePoint, JSON.stringify(s)],
      );
    return [...stats.values()];
  }
}
