import type { PoolClient } from "pg";
import { z } from "zod";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { Actor, EvidenceRef } from "../../../../../packages/contracts/src/domain.js";
import type {
  DiagnosisReviewInput,
} from "../../../../../packages/contracts/src/learning-evaluation.js";
import { invalidateDerivedEvidence } from "../learning-profile/invalidation.js";
import { auditInsight, requireAdminInsightScope } from "./policy.js";

export const DIAGNOSIS_REVIEW_ACTION = "student_insight.diagnosis_review";

const CODE_LABELS: Record<string, string> = {
  execution_slip: "操作失误",
  condition_omission: "条件遗漏",
  concept_gap: "知识缺口",
  rule_misuse: "规则误用",
  strategy_gap: "策略不足",
  expression_gap: "表达缺口",
  input_issue: "作答输入问题",
};

type DiagnosisRow = {
  id: string;
  attempt_id: string;
  version: number;
  status: string;
  primary_code: string | null;
  summary: string;
  evidence: EvidenceRef[];
  rule_version: string;
  message_version_id: string | null;
  question_version_id: string;
};

const EVIDENCE_OWNERSHIP: Record<string, string> = {
  message_version:
    "SELECT 1 FROM message_versions v JOIN messages m ON m.id=v.message_id JOIN conversations c ON c.id=m.conversation_id WHERE v.id=$1 AND c.student_id=$2",
  probe_response:
    "SELECT 1 FROM message_versions v JOIN messages m ON m.id=v.message_id JOIN conversations c ON c.id=m.conversation_id WHERE v.id=$1 AND c.student_id=$2",
  question_version:
    "SELECT 1 FROM question_versions v JOIN questions q ON q.id=v.question_id WHERE v.id=$1 AND (q.student_id=$2 OR q.student_id IS NULL)",
  process_step:
    "SELECT 1 FROM attempt_process_evidence e JOIN attempts a ON a.id=e.attempt_id WHERE e.id=$1 AND a.student_id=$2",
  knowledge_snapshot:
    "SELECT 1 FROM attempt_process_evidence e JOIN attempts a ON a.id=e.attempt_id WHERE e.id=$1 AND a.student_id=$2",
  assessment:
    "SELECT 1 FROM assessments s JOIN attempts a ON a.id=s.attempt_id WHERE s.id=$1 AND a.student_id=$2",
  diagnosis:
    "SELECT 1 FROM error_diagnoses d JOIN attempts a ON a.id=d.attempt_id WHERE d.id=$1 AND a.student_id=$2",
};

function refKey(ref: EvidenceRef): string {
  return `${ref.kind}:${ref.id}`;
}

function mergeEvidence(
  base: EvidenceRef[],
  added: EvidenceRef[],
): EvidenceRef[] {
  const seen = new Map<string, EvidenceRef>();
  for (const ref of [...base, ...added]) seen.set(refKey(ref), ref);
  return [...seen.values()];
}

async function assertEvidenceOwned(
  tx: PoolClient,
  studentId: string,
  evidence: EvidenceRef[],
): Promise<void> {
  for (const ref of evidence) {
    const sql = EVIDENCE_OWNERSHIP[ref.kind];
    const id = ref.versionId ?? ref.id;
    if (!sql) throw new AppError("VALIDATION", 422, "证据类型不可用于复核");
    const match = await tx.query(sql, [id, studentId]);
    if (!match.rowCount)
      throw new AppError("VALIDATION", 422, "证据不属于该学生或已不可用");
  }
}

function reviewOutcome(
  target: DiagnosisRow,
  input: DiagnosisReviewInput,
): { status: string; primaryCode: string | null; summary: string } {
  if (input.decision === "accept")
    return {
      status: target.status,
      primaryCode: target.primary_code,
      summary: `${target.summary} 管理员复核：认可当前结论。${input.reason}`,
    };
  if (input.decision === "correct") {
    const code = input.correctedCode!;
    const label = CODE_LABELS[code] ?? code;
    return {
      status: "confirmed",
      primaryCode: code,
      summary: `管理员复核更正：错因为${label}。${input.reason}（原判定：${target.summary}）`,
    };
  }
  return {
    status: "unsupported",
    primaryCode: null,
    summary: `管理员复核：现有证据只能确认作答情况，错因暂不确认。${input.reason}`,
  };
}

export class DiagnosisReviewService {
  constructor(private db: Database) {}

  async submit(
    actor: Actor,
    input: DiagnosisReviewInput & { studentId: string },
  ): Promise<{ reviewId: string; diagnosisVersion: number }> {
    const scope = await requireAdminInsightScope(
      this.db,
      actor,
      input.studentId,
    );
    const diagnosisId = z.uuid().parse(input.diagnosisId);

    return inTransaction(this.db, async (tx) => {
      const replay = (
        await tx.query<{ id: string; result_version: number }>(
          "SELECT id,result_version FROM diagnosis_reviews WHERE reviewer_id=$1 AND student_id=$2 AND request_key=$3",
          [scope.actor.userId, scope.studentId, input.requestKey],
        )
      ).rows[0];
      if (replay)
        return {
          reviewId: replay.id,
          diagnosisVersion: replay.result_version,
        };

      const target = (
        await tx.query<DiagnosisRow>(
          `SELECT d.id,d.attempt_id,d.version,d.status,d.primary_code,d.summary,
             d.evidence,d.rule_version,d.question_version_id,
             a.message_version_id
           FROM error_diagnoses d
           JOIN attempts a ON a.id=d.attempt_id
           WHERE d.id=$1 AND a.student_id=$2`,
          [diagnosisId, scope.studentId],
        )
      ).rows[0];
      if (!target) throw new AppError("NOT_FOUND", 404, "诊断不存在");

      // 同一作答的诊断版本链串行追加，避免并发复核写出重复版本号。
      await tx.query(
        "SELECT id FROM error_diagnoses WHERE attempt_id=$1 ORDER BY version DESC LIMIT 1 FOR UPDATE",
        [target.attempt_id],
      );
      const latest = (
        await tx.query<{ version: number }>(
          "SELECT coalesce(max(version),0) AS version FROM error_diagnoses WHERE attempt_id=$1",
          [target.attempt_id],
        )
      ).rows[0]!.version;
      if (target.version !== latest || input.expectedVersion !== latest)
        throw new AppError(
          "CONFLICT",
          409,
          "诊断已被更新，请刷新后再复核",
        );

      if (input.decision === "correct" && !input.correctedCode)
        throw new AppError("VALIDATION", 422, "纠正诊断必须指定错因代码");
      if (input.decision === "correct" && input.evidence.length === 0)
        throw new AppError("VALIDATION", 422, "纠正诊断必须提供证据");
      await assertEvidenceOwned(tx, scope.studentId, input.evidence);

      const outcome = reviewOutcome(target, input);
      const version = latest + 1;
      const evidence = mergeEvidence(target.evidence ?? [], input.evidence);
      const created = (
        await tx.query<{ id: string }>(
          `INSERT INTO error_diagnoses(
             attempt_id,assessment_id,question_version_id,version,status,
             primary_code,summary,evidence,rule_version,model_version,created_by)
           VALUES(
             $1,
             (SELECT id FROM assessments WHERE attempt_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1),
             $2,$3,$4,$5,$6,$7::jsonb,$8,'human_review',$9)
           RETURNING id`,
          [
            target.attempt_id,
            target.question_version_id,
            version,
            outcome.status,
            outcome.primaryCode,
            outcome.summary,
            JSON.stringify(evidence),
            target.rule_version,
            scope.actor.userId,
          ],
        )
      ).rows[0]!;

      if (input.decision === "accept") {
        await tx.query(
          `INSERT INTO diagnosis_candidates(
             diagnosis_id,code,skill_id,status,earliest_error,supports,contradicts,probe)
           SELECT $1,code,skill_id,status,earliest_error,supports,contradicts,probe
           FROM diagnosis_candidates WHERE diagnosis_id=$2`,
          [created.id, target.id],
        );
      } else if (input.decision === "correct") {
        await tx.query(
          `INSERT INTO diagnosis_candidates(diagnosis_id,code,status,supports)
           VALUES($1,$2,'confirmed',$3::jsonb)`,
          [created.id, input.correctedCode, JSON.stringify(input.evidence)],
        );
      }

      const review = (
        await tx.query<{ id: string }>(
          `INSERT INTO diagnosis_reviews(
             diagnosis_id,attempt_id,student_id,reviewer_id,decision,
             corrected_code,reason,evidence,expected_version,result_version,request_key)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
           RETURNING id`,
          [
            target.id,
            target.attempt_id,
            scope.studentId,
            scope.actor.userId,
            input.decision,
            input.correctedCode,
            input.reason,
            JSON.stringify(input.evidence),
            input.expectedVersion,
            version,
            input.requestKey,
          ],
        )
      ).rows[0]!;

      if (input.decision !== "accept") {
        const reason = "诊断结论经管理员复核变更，原推荐依据不再适用";
        const skills = await invalidateDerivedEvidence(
          tx,
          { actor: scope.actor, studentId: scope.studentId },
          target.message_version_id ?? target.question_version_id,
          reason,
        );
        await tx.query(
          `UPDATE practice_decisions
              SET invalidated_at=now(), invalid_reason=$4
            WHERE student_id=$1 AND invalidated_at IS NULL
              AND (skill_id = ANY($2::uuid[]) OR question_version_id=$3)`,
          [
            scope.studentId,
            skills,
            target.question_version_id,
            reason,
          ],
        );
      }

      await auditInsight(tx, scope, DIAGNOSIS_REVIEW_ACTION, {
        diagnosisId: target.id,
        attemptId: target.attempt_id,
        decision: input.decision,
        correctedCode: input.correctedCode,
        resultVersion: version,
        reviewId: review.id,
      });

      return { reviewId: review.id, diagnosisVersion: version };
    });
  }
}
