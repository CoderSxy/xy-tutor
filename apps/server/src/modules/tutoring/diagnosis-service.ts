import { createHash } from "node:crypto";
import { z } from "zod";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import {
  diagnosisCodeSchema,
  type DiagnosisCandidate,
  type DiagnosisContext,
  type DiagnosisDTO,
  type DiagnosisEvidenceRef,
} from "../../../../../packages/contracts/src/tutoring.js";
import { evidenceRefSchema } from "../../../../../packages/contracts/src/evidence.js";
import type { ModelGateway } from "../../agent/provider.js";
import { parseModelJson } from "../learning/practice.js";
import { searchPublishedKnowledge } from "../knowledge-base/search.js";
import type { AuthService } from "../auth/service.js";
import { decideDiagnosis, DIAGNOSIS_RULE_VERSION } from "./diagnosis-rules.js";
import { invalidateDiagnosesForEvidence } from "./diagnosis-invalidation.js";
import { ProcessEvidenceService } from "./process-evidence.js";

export { invalidateDiagnosesForEvidence } from "./diagnosis-invalidation.js";

const MODEL_VERSION_FALLBACK = "unavailable";
const DIAGNOSIS_TIMEOUT_MS = 60_000;

const modelRefSchema = z.preprocess(
  // 模型会把展示用的字段（steps、snapshot）原样抄回来；只保留可核对的引用字段。
  (value) =>
    value && typeof value === "object"
      ? {
          kind: (value as { kind?: unknown }).kind,
          id: (value as { id?: unknown }).id,
          ...((value as { versionId?: unknown }).versionId
            ? { versionId: (value as { versionId?: unknown }).versionId }
            : {}),
        }
      : value,
  evidenceRefSchema,
);

const modelOutputSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            code: diagnosisCodeSchema,
            skillId: z.uuid().nullable().default(null),
            status: z
              .enum(["hypothesis", "supported", "confirmed", "rejected"])
              .default("hypothesis"),
            earliestError: modelRefSchema.nullable().default(null),
            supports: z.array(modelRefSchema).default([]),
            contradicts: z.array(modelRefSchema).default([]),
            probe: z.string().max(500).nullable().default(null),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();

type AttemptRow = {
  id: string;
  student_id: string;
  task_id: string;
  question_version_id: string;
  message_version_id: string | null;
  answer: string;
  stem: string;
  knowledge_point: string | null;
};

type AssessmentRow = {
  id: string;
  correctness: "correct" | "incorrect" | "uncertain";
  verification: "verified" | "pending";
};

type DiagnosisRow = {
  id: string;
  attempt_id: string;
  version: number;
  status: DiagnosisDTO["status"];
  primary_code: DiagnosisDTO["primaryCode"];
  summary: string;
  evidence: DiagnosisEvidenceRef[];
  rule_version: string;
};

type CandidateRow = {
  code: DiagnosisCandidate["code"];
  skill_id: string | null;
  status: DiagnosisCandidate["status"];
  earliest_error: DiagnosisEvidenceRef | null;
  supports: DiagnosisEvidenceRef[];
  contradicts: DiagnosisEvidenceRef[];
  probe: string | null;
};

const refKey = (ref: DiagnosisEvidenceRef) => `${ref.kind}:${ref.id}`;

function basisKey(refs: DiagnosisEvidenceRef[]): string {
  return [...new Set(refs.map(refKey))].sort().join("|");
}

function toDto(row: DiagnosisRow, candidates: CandidateRow[]): DiagnosisDTO {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    version: row.version,
    status: row.status,
    primaryCode: row.primary_code,
    summary: row.summary,
    evidence: row.evidence,
    ruleVersion: row.rule_version,
    candidates: candidates.map((candidate) => ({
      code: candidate.code,
      skillId: candidate.skill_id,
      status: candidate.status,
      earliestError: candidate.earliest_error,
      supports: candidate.supports,
      contradicts: candidate.contradicts,
      probe: candidate.probe,
    })),
  };
}

type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null }>;
};

async function assertEvidenceOwnership(
  client: Queryable,
  studentId: string,
  evidenceVersionId: string,
) {
  const match = await client.query(
    "SELECT 1 FROM message_versions v JOIN messages m ON m.id=v.message_id JOIN conversations c ON c.id=m.conversation_id WHERE v.id=$1 AND c.student_id=$2 UNION ALL SELECT 1 FROM question_versions v JOIN questions q ON q.id=v.question_id WHERE v.id=$1 AND q.student_id=$2",
    [evidenceVersionId, studentId],
  );
  return (match.rowCount ?? 0) > 0;
}

export class DiagnosisService {
  private processEvidence: ProcessEvidenceService;

  constructor(
    private db: Database,
    private auth: AuthService,
    private gateway?: ModelGateway,
  ) {
    this.processEvidence = new ProcessEvidenceService(db, auth);
  }

  async latest(
    scope: StudentScope,
    attemptId: string,
  ): Promise<DiagnosisDTO | null> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    return this.loadLatest(scope.studentId, attemptId);
  }

  async analyze(scope: StudentScope, attemptId: string): Promise<DiagnosisDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const attempt = (
      await this.db.pool.query<AttemptRow>(
        "SELECT a.id,a.student_id,a.task_id,a.question_version_id,a.message_version_id,a.answer,v.stem,v.knowledge_point FROM attempts a JOIN question_versions v ON v.id=a.question_version_id JOIN questions q ON q.id=v.question_id WHERE a.id=$1 AND a.student_id=$2 AND (q.student_id=$2 OR q.student_id IS NULL)",
        [attemptId, scope.studentId],
      )
    ).rows[0];
    if (!attempt) throw new AppError("NOT_FOUND", 404, "作答不存在");

    const assessment = (
      await this.db.pool.query<AssessmentRow>(
        "SELECT id,correctness,verification FROM assessments WHERE attempt_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
        [attempt.id],
      )
    ).rows[0];
    const probeEvidence = await this.loadProbeEvidence(attempt);
    const processEvidence = await this.processEvidence.collect(scope, attempt.id);
    const knowledge = await this.freezeKnowledge(attempt);
    if (knowledge) processEvidence.push(knowledge.ref);

    const invalid = (
      await this.db.pool.query(
        "SELECT 1 FROM evidence_invalidations WHERE student_id=$1 AND evidence_version_id=ANY($2::uuid[])",
        [
          scope.studentId,
          [attempt.question_version_id, attempt.message_version_id].filter(
            Boolean,
          ),
        ],
      )
    ).rowCount;
    const reference = (
      await this.db.pool.query<{ answer_type: string }>(
        "SELECT answer_type FROM question_references WHERE question_version_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
        [attempt.question_version_id],
      )
    ).rows[0];

    const context: DiagnosisContext = {
      assessmentId: assessment?.id ?? null,
      attemptId: attempt.id,
      questionVersionId: attempt.question_version_id,
      processEvidence,
      probeEvidence,
      assessment: assessment
        ? { correctness: assessment.correctness, verification: assessment.verification }
        : null,
      stemConfirmed: !invalid,
      knowledgeAvailable: !!knowledge,
      supportedQuestionType: reference?.answer_type !== "open",
    };

    const basis = basisKey([
      ...processEvidence,
      ...probeEvidence,
      ...(assessment ? [{ kind: "assessment", id: assessment.id }] : []),
      {
        kind: "question_version",
        id: attempt.question_version_id,
        versionId: attempt.question_version_id,
      },
    ]);
    const latest = await this.loadLatest(scope.studentId, attempt.id);
    if (latest) {
      const stored = (
        await this.db.pool.query<{ evidence: DiagnosisEvidenceRef[] }>(
          "SELECT evidence FROM error_diagnoses WHERE id=$1",
          [latest.id],
        )
      ).rows[0];
      if (stored && basisKey(stored.evidence) === basis) return latest;
    }

    let candidates: DiagnosisCandidate[] = [];
    let unavailable = false;
    let modelVersion: string | null = null;
    if (context.assessment?.verification === "verified" && this.gateway) {
      try {
        const output = await this.gateway.complete(
          {
            context: {
              systemPrompt:
                "你是错因诊断助手。只能从给定的证据列表中引用证据，不能虚构证据 ID；不能凭最终答案对错、耗时长短或学生自称‘会了’确认错因。只输出 JSON {candidates:[{code,skillId,status,earliestError,supports,contradicts,probe}]}，最多 3 个候选。earliestError 必须是学生在场过程步骤的证据；需要区分时在 probe 里写一个具体的小问题。",
              messages: [
                {
                  role: "user",
                  timestamp: Date.now(),
                  content: JSON.stringify({
                    stem: attempt.stem,
                    answer: attempt.answer,
                    knowledgePoint: attempt.knowledge_point,
                    assessment: context.assessment,
                    evidence: await this.describeEvidence(
                      processEvidence,
                      probeEvidence,
                    ),
                  }),
                },
              ],
            },
          },
          AbortSignal.timeout(DIAGNOSIS_TIMEOUT_MS),
        );
        candidates = modelOutputSchema.parse(
          parseModelJson(output.text),
        ).candidates;
        modelVersion = this.gateway.runtime.model.id;
      } catch {
        unavailable = true;
      }
    } else if (
      context.assessment?.verification === "verified" &&
      !this.gateway
    ) {
      unavailable = true;
    }

    if (unavailable && latest) return latest;
    const decision = decideDiagnosis(context, candidates);
    if (unavailable)
      decision.summary =
        "自动诊断暂时不可用，已保留原作答；稍后可以再试一次。";
    return this.persist(scope, attempt, context, decision, modelVersion);
  }

  async invalidate(
    scope: StudentScope,
    evidenceVersionId: string,
    reason: string,
  ): Promise<void> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    if (!(await assertEvidenceOwnership(this.db.pool, scope.studentId, evidenceVersionId)))
      throw new AppError("NOT_FOUND", 404, "证据不存在");
    await invalidateDiagnosesForEvidence(
      this.db.pool,
      scope.studentId,
      evidenceVersionId,
      reason,
    );
  }

  private async loadLatest(
    studentId: string,
    attemptId: string,
  ): Promise<DiagnosisDTO | null> {
    const row = (
      await this.db.pool.query<DiagnosisRow>(
        "SELECT d.* FROM error_diagnoses d JOIN attempts a ON a.id=d.attempt_id WHERE d.attempt_id=$1 AND a.student_id=$2 ORDER BY d.version DESC LIMIT 1",
        [attemptId, studentId],
      )
    ).rows[0];
    if (!row) return null;
    const candidates = (
      await this.db.pool.query<CandidateRow>(
        "SELECT code,skill_id,status,earliest_error,supports,contradicts,probe FROM diagnosis_candidates WHERE diagnosis_id=$1 ORDER BY created_at,id",
        [row.id],
      )
    ).rows;
    return toDto(row, candidates);
  }

  private async loadProbeEvidence(
    attempt: AttemptRow,
  ): Promise<DiagnosisEvidenceRef[]> {
    const rows = (
      await this.db.pool.query<{ id: string }>(
        `SELECT DISTINCT v.id
         FROM tutoring_actions act
         JOIN tutoring_episodes e ON e.id=act.episode_id
         JOIN message_versions tv ON tv.id=act.message_version_id
         JOIN messages tm ON tm.id=tv.message_id
         JOIN messages um ON um.conversation_id=tm.conversation_id AND um.role='user'
         JOIN message_versions v ON v.message_id=um.id
         WHERE e.student_id=$1 AND e.task_id=$2 AND act.kind='request_probe'
           AND v.created_at > tv.created_at
           AND ($3::uuid IS NULL OR v.id <> $3)`,
        [attempt.student_id, attempt.task_id, attempt.message_version_id],
      )
    ).rows;
    return rows.map((row) => ({
      kind: "probe_response",
      id: row.id,
      versionId: row.id,
    }));
  }

  /** Freezes the published knowledge text actually used for this diagnosis. */
  private async freezeKnowledge(
    attempt: AttemptRow,
  ): Promise<{ ref: DiagnosisEvidenceRef } | null> {
    const keywords = attempt.knowledge_point?.trim();
    if (!keywords) return null;
    const hit = (
      await searchPublishedKnowledge(this.db, { keywords, limit: 1 })
    )[0];
    if (!hit) return null;
    const item = (
      await this.db.pool.query<{
        id: string;
        title: string;
        summary: string;
        updated_at: Date;
      }>(
        "SELECT id,title,summary,updated_at FROM knowledge_items WHERE id=$1 AND status='published'",
        [hit.id],
      )
    ).rows[0];
    if (!item) return null;
    const content = JSON.stringify({
      knowledgeItemId: item.id,
      title: item.title,
      summary: item.summary,
      updatedAt: item.updated_at.toISOString(),
    });
    const hash = createHash("sha256").update(content).digest("hex");
    const inserted = (
      await this.db.pool.query<{ id: string }>(
        "INSERT INTO attempt_process_evidence(attempt_id,kind,content,content_hash) VALUES($1,'knowledge_snapshot',$2,$3) ON CONFLICT (attempt_id,kind,content_hash) DO NOTHING RETURNING id",
        [attempt.id, content, hash],
      )
    ).rows[0];
    const row =
      inserted ??
      (
        await this.db.pool.query<{ id: string }>(
          "SELECT id FROM attempt_process_evidence WHERE attempt_id=$1 AND kind='knowledge_snapshot' AND content_hash=$2",
          [attempt.id, hash],
        )
      ).rows[0];
    return row ? { ref: { kind: "knowledge_snapshot", id: row.id } } : null;
  }

  private async describeEvidence(
    processEvidence: DiagnosisEvidenceRef[],
    probeEvidence: DiagnosisEvidenceRef[],
  ) {
    const stepRows = (
      await this.db.pool.query<{
        id: string;
        kind: string;
        content: string | null;
        step_refs: { index: number; text: string }[];
      }>(
        "SELECT id,kind,content,step_refs FROM attempt_process_evidence WHERE id=ANY($1::uuid[])",
        [processEvidence.map((ref) => ref.id)],
      )
    ).rows;
    const details = new Map(stepRows.map((row) => [row.id, row]));
    const probeIds = probeEvidence.map((ref) => ref.id);
    const probeTexts = probeIds.length
      ? (
          await this.db.pool.query<{ id: string; content: string }>(
            "SELECT id,content FROM message_versions WHERE id=ANY($1::uuid[])",
            [probeIds],
          )
        ).rows
      : [];
    return [
      ...processEvidence.map((ref) => {
        const row = details.get(ref.id);
        return {
          kind: ref.kind,
          id: ref.id,
          steps: row?.step_refs.map((step) => step.text) ?? undefined,
          snapshot: row?.kind === "knowledge_snapshot" ? row.content : undefined,
        };
      }),
      ...probeEvidence.map((ref) => ({
        kind: ref.kind,
        id: ref.id,
        response: probeTexts.find((row) => row.id === ref.id)?.content,
      })),
    ];
  }

  private async persist(
    scope: StudentScope,
    attempt: AttemptRow,
    context: DiagnosisContext,
    decision: Omit<DiagnosisDTO, "id" | "version">,
    modelVersion: string | null,
  ): Promise<DiagnosisDTO> {
    return inTransaction(this.db, async (tx) => {
      await tx.query(
        "SELECT id FROM error_diagnoses WHERE attempt_id=$1 ORDER BY version DESC LIMIT 1 FOR UPDATE",
        [attempt.id],
      );
      const version = (
        await tx.query<{ version: number }>(
          "SELECT coalesce(max(version),0)+1 AS version FROM error_diagnoses WHERE attempt_id=$1",
          [attempt.id],
        )
      ).rows[0]!.version;
      const row = (
        await tx.query<DiagnosisRow>(
          "INSERT INTO error_diagnoses(attempt_id,assessment_id,question_version_id,version,status,primary_code,summary,evidence,rule_version,model_version,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING *",
          [
            attempt.id,
            context.assessmentId,
            attempt.question_version_id,
            version,
            decision.status,
            decision.primaryCode,
            decision.summary,
            JSON.stringify(decision.evidence),
            decision.ruleVersion || DIAGNOSIS_RULE_VERSION,
            modelVersion ?? MODEL_VERSION_FALLBACK,
            scope.actor.userId,
          ],
        )
      ).rows[0]!;
      for (const candidate of decision.candidates)
        await tx.query(
          "INSERT INTO diagnosis_candidates(diagnosis_id,code,skill_id,status,earliest_error,supports,contradicts,probe) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8)",
          [
            row.id,
            candidate.code,
            candidate.skillId,
            candidate.status,
            candidate.earliestError
              ? JSON.stringify(candidate.earliestError)
              : null,
            JSON.stringify(candidate.supports),
            JSON.stringify(candidate.contradicts),
            candidate.probe,
          ],
        );
      const candidates = (
        await tx.query<CandidateRow>(
          "SELECT code,skill_id,status,earliest_error,supports,contradicts,probe FROM diagnosis_candidates WHERE diagnosis_id=$1 ORDER BY created_at,id",
          [row.id],
        )
      ).rows;
      return toDto(row, candidates);
    });
  }
}
