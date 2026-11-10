import { z } from "zod";
import type {
  StudentScope,
  EvidenceRef,
} from "../../../../../packages/contracts/src/domain.js";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { AuthService } from "../auth/service.js";
import type { ModelGateway } from "../../agent/provider.js";
import { parseModelJson } from "./practice.js";
export type SummaryContent = {
  text: string;
  attemptCount: number;
  verifiedCorrect: number;
  verifiedIncorrect: number;
  pending: number;
  evidence: EvidenceRef[];
};
export class SummaryService {
  constructor(
    readonly db: Database,
    readonly auth: AuthService,
    private gateway?: ModelGateway,
  ) {}
  private async facts(
    studentId: string,
    taskId: string,
  ): Promise<SummaryContent> {
    const attempts = (
      await this.db.pool.query(
        "SELECT a.id,a.question_version_id,a.message_version_id,s.id AS assessment_id,s.correctness,s.verification FROM attempts a LEFT JOIN LATERAL(SELECT id,correctness,verification FROM assessments WHERE attempt_id=a.id ORDER BY created_at DESC,id DESC LIMIT 1)s ON true WHERE a.task_id=$1 AND a.student_id=$2 AND NOT EXISTS(SELECT 1 FROM evidence_invalidations i WHERE i.student_id=a.student_id AND (i.evidence_version_id=a.question_version_id OR i.evidence_version_id=a.message_version_id))",
        [taskId, studentId],
      )
    ).rows;
    const correct = attempts.filter(
      (a) => a.verification === "verified" && a.correctness === "correct",
    ).length;
    const incorrect = attempts.filter(
      (a) => a.verification === "verified" && a.correctness === "incorrect",
    ).length;
    const evidence: EvidenceRef[] = attempts.flatMap((a) => [
      { kind: "attempt", id: a.id, versionId: a.question_version_id },
      ...(a.assessment_id ? [{ kind: "assessment", id: a.assessment_id }] : []),
      ...(a.message_version_id
        ? [
            {
              kind: "message_version",
              id: a.message_version_id,
              versionId: a.message_version_id,
            },
          ]
        : []),
    ]);
    return {
      text: `本次记录${attempts.length}次作答，其中${correct}次核验正确、${incorrect}次核验错误，其余待核验。`,
      attemptCount: attempts.length,
      verifiedCorrect: correct,
      verifiedIncorrect: incorrect,
      pending: attempts.length - correct - incorrect,
      evidence,
    };
  }
  async generate(input: { taskId: string }): Promise<void> {
    z.uuid().parse(input.taskId);
    const task = (
      await this.db.pool.query("SELECT * FROM learning_tasks WHERE id=$1", [
        input.taskId,
      ])
    ).rows[0];
    if (!task || task.status !== "completed") throw Error("TASK_NOT_COMPLETED");
    const content = await this.facts(task.student_id, task.id);
    let model = "structured-facts-v1";
    if (this.gateway) {
      try {
        const r = await this.gateway.complete(
          {
            priority: "background",
            context: {
              systemPrompt:
                "根据结构化事实生成简短学习小结，不能由一次正确声称整个知识点已掌握，不能添加不存在的证据。仅输出JSON {text:string}。",
              messages: [
                {
                  role: "user",
                  content: JSON.stringify(content),
                  timestamp: Date.now(),
                },
              ],
            },
          },
          AbortSignal.timeout(60000),
        );
        const generated = z
          .object({ text: z.string().max(3000) })
          .parse(parseModelJson(r.text));
        content.text = generated.text;
        model = this.gateway.runtime.model.id;
      } catch {
        /* The factual summary remains useful without a model. */
      }
    }
    await inTransaction(this.db, async (tx) => {
      await tx.query("SELECT id FROM learning_tasks WHERE id=$1 FOR UPDATE", [
        task.id,
      ]);
      const version = (
        await tx.query(
          "SELECT COALESCE(MAX(version_no),0)+1 AS n FROM learning_summaries WHERE task_id=$1",
          [task.id],
        )
      ).rows[0].n;
      const saved = (
        await tx.query(
          "INSERT INTO learning_summaries(student_id,task_id,version_no,content,model,prompt_version) VALUES($1,$2,$3,$4,$5,'summary-v1') RETURNING id",
          [task.student_id, task.id, version, JSON.stringify(content), model],
        )
      ).rows[0];
      for (const e of content.evidence)
        await tx.query(
          "INSERT INTO summary_evidence(summary_id,kind,source_id,version_id) VALUES($1,$2,$3,$4)",
          [saved.id, e.kind, e.id, e.versionId ?? null],
        );
    });
  }
  async latest(
    scope: StudentScope,
    taskId: string,
  ): Promise<{
    id: string | null;
    content: SummaryContent;
    source: string;
  } | null> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const task = (
      await this.db.pool.query(
        "SELECT status FROM learning_tasks WHERE id=$1 AND student_id=$2",
        [taskId, scope.studentId],
      )
    ).rows[0];
    if (!task) throw new AppError("NOT_FOUND", 404, "任务不存在");
    const row = (
      await this.db.pool.query(
        `SELECT s.id,s.content FROM learning_summaries s WHERE s.task_id=$1 AND s.student_id=$2 AND NOT EXISTS(SELECT 1 FROM summary_evidence e JOIN evidence_invalidations i ON i.evidence_version_id=e.version_id AND i.student_id=s.student_id WHERE e.summary_id=s.id) AND NOT EXISTS(SELECT 1 FROM summary_evidence e JOIN assessments old ON e.kind='assessment' AND old.id=e.source_id JOIN assessments newer ON newer.attempt_id=old.attempt_id WHERE e.summary_id=s.id AND (newer.created_at,newer.id)>(old.created_at,old.id)) ORDER BY s.version_no DESC LIMIT 1`,
        [taskId, scope.studentId],
      )
    ).rows[0];
    if (row) return { ...row, source: "saved" };
    return task.status === "completed"
      ? {
          id: null,
          content: await this.facts(scope.studentId, taskId),
          source: "current_facts",
        }
      : null;
  }
  async relevant(scope: StudentScope, revisionId: string | null) {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const tasks = (
      await this.db.pool.query(
        "SELECT id FROM learning_tasks WHERE student_id=$1 AND ($2::uuid IS NULL OR revision_id=$2) AND status='completed' ORDER BY updated_at DESC LIMIT 3",
        [scope.studentId, revisionId],
      )
    ).rows;
    const results = [];
    for (const t of tasks) {
      const summary = await this.latest(scope, t.id);
      if (summary) results.push({ taskId: t.id, ...summary });
    }
    return results;
  }
}
