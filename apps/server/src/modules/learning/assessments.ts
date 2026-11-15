import { z } from "zod";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import {
  IMAGE_READ_TIMEOUT_MS,
  MAX_MODEL_IMAGE_BYTES,
  MAX_MODEL_IMAGES,
} from "../../../../../packages/contracts/src/conversation-images.js";
import type { AuthService } from "../auth/service.js";
import type { CatalogService } from "../catalog/service.js";
import { TextbookSearch } from "../catalog/search.js";
import type { FileStore } from "../../infra/oss.js";
import type { ModelGateway } from "../../agent/provider.js";
import {
  ImageEvidenceReader,
  type LoadedImage,
} from "../conversations/attachments.js";
import { AssessmentVerifier, type Correctness } from "./verifier.js";
import { referenceSchema, checkReference, parseModelJson } from "./practice.js";
import { invalidateDiagnosesForEvidence } from "../tutoring/diagnosis-invalidation.js";
import { combineHintDependency } from "../tutoring/state-rules.js";
import type { Exposure } from "../../../../../packages/contracts/src/tutoring.js";
import type { DiagnosisService } from "../tutoring/diagnosis-service.js";
import type { LearningProfileService } from "../learning-profile/service.js";
import { equivalent } from "./verifier.js";
import { enqueueJob } from "../../jobs/queue.js";
import { publishStudentText } from "../question-bank/student-language.js";
export type AssessmentDTO = {
  id: string;
  attemptId: string;
  correctness: Correctness;
  verification: "verified" | "pending";
  hintDependency: "none" | "guided" | "solution_exposed" | "unknown";
  reason: string;
};
export class AssessmentService {
  constructor(
    readonly db: Database,
    readonly auth: AuthService,
    private catalog: CatalogService,
    private gateway?: ModelGateway,
    private store?: FileStore,
    private learning?: {
      diagnosis?: DiagnosisService;
      profiles?: LearningProfileService;
    },
  ) {}

  private async existingAssessment(attemptId: string) {
    return (
      await this.db.pool.query(
        `SELECT id,attempt_id AS "attemptId",correctness,verification,
                hint_dependency AS "hintDependency",evidence,created_at
         FROM assessments WHERE attempt_id=$1
         ORDER BY created_at DESC,id DESC LIMIT 1`,
        [attemptId],
      )
    ).rows[0];
  }

  private async enqueueSync(
    tx: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    scope: StudentScope,
    assessmentId: string,
  ) {
    await enqueueJob(tx as never, {
      kind: "learning.mistake-sync",
      dedupeKey: `learning.mistake-sync:${assessmentId}`,
      payload: {
        assessmentId,
        studentId: scope.studentId,
        actorId: scope.actor.userId,
      },
    });
  }

  async assessAttempt(
    scope: StudentScope,
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<AssessmentDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    z.uuid().parse(attemptId);
    const a = (
      await this.db.pool.query(
        `SELECT a.id,a.answer,a.task_id,a.question_version_id,a.message_version_id,
                a.created_at,v.stem
         FROM attempts a JOIN question_versions v ON v.id=a.question_version_id
         WHERE a.id=$1 AND a.student_id=$2`,
        [attemptId, scope.studentId],
      )
    ).rows[0];
    if (!a) throw new AppError("NOT_FOUND", 404, "作答不存在");
    const existing = await this.existingAssessment(attemptId);
    if (existing) {
      await this.enqueueSync(this.db.pool, scope, existing.id as string);
      return {
        id: existing.id,
        attemptId,
        correctness: existing.correctness,
        verification: existing.verification,
        hintDependency: existing.hintDependency,
        reason:
          existing.verification === "verified"
            ? "已复用已有评估"
            : "依据不足或核验不一致，暂不能可靠判定",
      };
    }
    const candidate = await this.deriveCandidate(a, signal);
    return this.submitCandidate(
      scope,
      {
        attemptId,
        correctness: candidate.correctness,
        reason: candidate.reason,
        referenceIds: [],
        ...(a.task_id ? { taskId: a.task_id } : {}),
      },
      signal,
    );
  }

  private async deriveCandidate(
    a: {
      id: string;
      answer: string;
      task_id: string | null;
      question_version_id: string;
      message_version_id: string | null;
    },
    signal?: AbortSignal,
  ): Promise<{ correctness: Correctness; reason: string }> {
    const ref = (
      await this.db.pool.query(
        "SELECT answer,answer_type,requires_working FROM question_references WHERE question_version_id=$1 AND verification='verified' ORDER BY created_at DESC LIMIT 1",
        [a.question_version_id],
      )
    ).rows[0];
    const hasImage = a.message_version_id
      ? !!(
          await this.db.pool.query(
            "SELECT 1 FROM message_attachments WHERE message_version_id=$1 LIMIT 1",
            [a.message_version_id],
          )
        ).rowCount
      : false;
    if (
      ref &&
      !hasImage &&
      !ref.requires_working &&
      (ref.answer_type === "number" || ref.answer_type === "choice")
    ) {
      const same = equivalent(
        a.answer,
        ref.answer,
        ref.answer_type as "number" | "choice",
      );
      if (same !== undefined)
        return {
          correctness: same ? "correct" : "incorrect",
          reason: "按已核验参考答案自动比对",
        };
    }
    if (!this.gateway) return { correctness: "uncertain", reason: "无法自动判题" };
    try {
      const response = await this.gateway.complete(
        {
          priority: "background",
          context: {
            systemPrompt:
              '独立判断学生正式作答是否正确。只输出JSON {correctness:"correct"|"incorrect"|"uncertain",reason:string}。证据不足时必须输出uncertain，不得猜测。',
            messages: [
              {
                role: "user",
                timestamp: Date.now(),
                content: JSON.stringify({
                  stem: (a as { stem?: string }).stem,
                  answer: a.answer,
                  referenceAnswer: ref?.answer ?? null,
                  requiresWorking: ref?.requires_working ?? null,
                }),
              },
            ],
          },
        },
        signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
          : AbortSignal.timeout(60000),
      );
      const parsed = z
        .object({
          correctness: z.enum(["correct", "incorrect", "uncertain"]),
          reason: z.string().max(2000),
        })
        .parse(parseModelJson(response.text));
      parsed.reason = await publishStudentText(
        parsed.reason,
        this.gateway,
        signal,
      );
      return parsed;
    } catch {
      return { correctness: "uncertain", reason: "自动判题暂时不可用" };
    }
  }

  async submitCandidate(
    scope: StudentScope,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<AssessmentDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const v = z
      .object({
        attemptId: z.uuid(),
        correctness: z.enum(["correct", "incorrect", "uncertain"]),
        reason: z.string().max(2000),
        referenceIds: z.array(z.uuid()).max(20),
        taskId: z.uuid().optional(),
      })
      .strict()
      .parse(input);
    const priorFinal = await this.existingAssessment(v.attemptId);
    if (priorFinal) {
      const priorCandidate = (
        priorFinal.evidence as {
          candidate?: { correctness?: string; reason?: string };
        }
      )?.candidate;
      if (
        priorFinal.verification === "verified" ||
        (priorCandidate?.correctness === v.correctness &&
          priorCandidate?.reason === v.reason)
      ) {
        await this.enqueueSync(this.db.pool, scope, priorFinal.id as string);
        return {
          id: priorFinal.id,
          attemptId: v.attemptId,
          correctness: priorFinal.correctness,
          verification: priorFinal.verification,
          hintDependency: priorFinal.hintDependency,
          reason:
            priorFinal.verification === "verified"
              ? "已复用已有评估"
              : "依据不足或核验不一致，暂不能可靠判定",
        };
      }
    }
    const a = (
      await this.db.pool.query(
        "SELECT a.*,v.stem,q.revision_id,q.source_type FROM attempts a JOIN question_versions v ON v.id=a.question_version_id JOIN questions q ON q.id=v.question_id WHERE a.id=$1 AND a.student_id=$2",
        [v.attemptId, scope.studentId],
      )
    ).rows[0];
    if (!a) throw new AppError("NOT_FOUND", 404, "作答不存在");
    const attachments = a.message_version_id
      ? (
          await this.db.pool.query<{ file_id: string; size: number }>(
            "SELECT ma.file_id,f.size FROM message_attachments ma JOIN files f ON f.id=ma.file_id WHERE ma.message_version_id=$1 AND f.status='ready' AND f.content_type LIKE 'image/%' ORDER BY ma.position",
            [a.message_version_id],
          )
        ).rows
      : [];
    const hasImageEvidence = attachments.length > 0;
    let images: LoadedImage[] = [];
    let imageUnreadable = false;
    if (hasImageEvidence) {
      const total = attachments.reduce(
        (sum, row) => sum + Number(row.size),
        0,
      );
      if (
        !this.store ||
        attachments.length > MAX_MODEL_IMAGES ||
        total > MAX_MODEL_IMAGE_BYTES
      )
        imageUnreadable = true;
      else {
        const reader = new ImageEvidenceReader(this.db, this.store);
        try {
          images = await reader.load(
            attachments.map((row) => row.file_id),
            AbortSignal.timeout(IMAGE_READ_TIMEOUT_MS),
          );
        } catch {
          imageUnreadable = true;
        } finally {
          reader.release();
        }
      }
    }
    if (
      v.taskId &&
      a.task_id !== v.taskId &&
      !(
        await this.db.pool.query(
          "SELECT 1 FROM task_items i JOIN learning_tasks t ON t.id=i.task_id WHERE i.task_id=$1 AND i.question_version_id=$2 AND t.student_id=$3",
          [v.taskId, a.question_version_id, scope.studentId],
        )
      ).rowCount
    )
      throw new AppError("NOT_FOUND", 404, "作答不属于当前任务");
    const search = new TextbookSearch(this.catalog);
    let citationsValid = true;
    if (a.revision_id) {
      try {
        await search.validateCitations(
          { student: scope, revisionId: a.revision_id },
          v.referenceIds,
        );
      } catch {
        citationsValid = false;
      }
    }
    const invalid = (
      await this.db.pool.query(
        "SELECT 1 FROM evidence_invalidations WHERE student_id=$1 AND evidence_version_id=ANY($2::uuid[])",
        [
          scope.studentId,
          [a.question_version_id, a.message_version_id].filter(Boolean),
        ],
      )
    ).rowCount;
    let ref = (
      await this.db.pool.query(
        "SELECT * FROM question_references WHERE question_version_id=$1 AND verification='verified' ORDER BY created_at DESC LIMIT 1",
        [a.question_version_id],
      )
    ).rows[0];
    if (!ref && this.gateway && !invalid) {
      try {
        const generated = await this.gateway.complete(
          {
            context: {
              systemPrompt:
                '独立为已确认题干求参考答案。只输出JSON {referenceAnswer,answerType:"number"|"choice"|"worked"|"open",requiresWorking:boolean,reason}；不要猜缺失题干。',
              messages: [
                { role: "user", content: a.stem, timestamp: Date.now() },
              ],
            },
          },
          signal
            ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
            : AbortSignal.timeout(60000),
        );
        const reference = referenceSchema.parse(parseModelJson(generated.text));
        const checked = await checkReference(
          this.gateway,
          a.stem,
          reference,
          signal,
        );
        if (checked.verified)
          ref = (
            await this.db.pool.query(
              "INSERT INTO question_references(question_version_id,answer,answer_type,requires_working,verification,evidence) VALUES($1,$2,$3,$4,'verified',$5) RETURNING *",
              [
                a.question_version_id,
                reference.referenceAnswer,
                reference.answerType,
                reference.requiresWorking,
                JSON.stringify({
                  generated: reference,
                  independent: checked.independent,
                  model: this.gateway.runtime.model.id,
                }),
              ],
            )
          ).rows[0];
      } catch {
        /* A failed reference check leaves assessment pending. */
      }
    }
    let independent:
      | {
          correctness: Correctness;
          evidenceSufficient: boolean;
          criteriaSatisfied: boolean;
        }
      | undefined;
    if (
      ref &&
      this.gateway &&
      !imageUnreadable &&
      (ref.requires_working ||
        ref.answer_type === "worked" ||
        hasImageEvidence)
    ) {
      try {
        const r = await this.gateway.complete(
          {
            context: {
              systemPrompt:
                '独立核验学生作答，依据题干、参考答案和过程要求。不要补造学生步骤。仅输出JSON {correctness:"correct"|"incorrect"|"uncertain",evidenceSufficient:boolean,criteriaSatisfied:boolean,reason:string}。',
              messages: [
                {
                  role: "user",
                  timestamp: Date.now(),
                  content: hasImageEvidence
                    ? [
                        {
                          type: "text" as const,
                          text: JSON.stringify({
                            stem: a.stem,
                            answer: a.answer,
                            reference: ref.answer,
                            requiresWorking: ref.requires_working,
                            hasImageEvidence: true,
                          }),
                        },
                        ...images.map(
                          (image): ImageContent => ({
                            type: "image",
                            data: image.data,
                            mimeType: image.mimeType,
                          }),
                        ),
                      ]
                    : JSON.stringify({
                        stem: a.stem,
                        answer: a.answer,
                        reference: ref.answer,
                        requiresWorking: ref.requires_working,
                      }),
                },
              ],
            },
          },
          signal
            ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
            : AbortSignal.timeout(60000),
        );
        independent = z
          .object({
            correctness: z.enum(["correct", "incorrect", "uncertain"]),
            evidenceSufficient: z.boolean(),
            criteriaSatisfied: z.boolean(),
          })
          .parse(parseModelJson(r.text));
      } catch {
        /* pending */
      }
    }
    const checked = await new AssessmentVerifier().verify({
      stemConfirmed: !invalid,
      referenceVerified: !!ref,
      answerType: ref?.answer_type ?? "open",
      requiresWorking: ref?.requires_working ?? true,
      answer: a.answer,
      referenceAnswer: ref?.answer,
      candidateCorrectness: v.correctness,
      citationsValid,
      hasImageEvidence,
      independent,
    });
    const dependency = await this.hintDependency({
      studentId: a.student_id,
      taskId: a.task_id as string | null,
      questionVersionId: a.question_version_id,
      messageVersionId: a.message_version_id as string | null,
      before: a.created_at as Date,
    });
    let reused:
      | {
          id: string;
          correctness: string;
          verification: "verified" | "pending";
          hintDependency: AssessmentDTO["hintDependency"];
        }
      | undefined;
    let result: { id: string } | undefined;
    await inTransaction(this.db, async (tx) => {
      await tx.query(
        "SELECT id FROM attempts WHERE id=$1 AND student_id=$2 FOR UPDATE",
        [a.id, scope.studentId],
      );
      const current = (
        await tx.query(
          `SELECT id,correctness,verification,hint_dependency AS "hintDependency",evidence
           FROM assessments WHERE attempt_id=$1
           ORDER BY created_at DESC,id DESC LIMIT 1`,
          [a.id],
        )
      ).rows[0];
      const currentCandidate = (
        current?.evidence as {
          candidate?: { correctness?: string; reason?: string };
        }
      )?.candidate;
      if (
        current &&
        (current.verification === "verified" ||
          (currentCandidate?.correctness === v.correctness &&
            currentCandidate?.reason === v.reason))
      ) {
        reused = {
          id: current.id,
          correctness: current.correctness,
          verification: current.verification,
          hintDependency: current.hintDependency,
        };
        await this.enqueueSync(tx, scope, current.id);
        return;
      }
      const prior = (
        await tx.query<{
          id: string;
          correctness: string;
          verification: string;
        }>(
          "SELECT id,correctness,verification FROM assessments WHERE attempt_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
          [a.id],
        )
      ).rows[0];
      const inserted: { id: string } = (
        await tx.query(
          "INSERT INTO assessments(attempt_id,correctness,verification,hint_dependency,method,verifier_version,reference_id,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
          [
            a.id,
            checked.correctness,
            checked.verification,
            dependency,
            checked.method,
            checked.verifierVersion,
            ref?.id ?? null,
            JSON.stringify({
              candidate: v,
              independent,
              referenceIds: v.referenceIds,
              citationsValid,
              imageEvidence: hasImageEvidence,
            }),
          ],
        )
      ).rows[0];
      result = inserted;
      if (
        prior &&
        (prior.correctness !== checked.correctness ||
          prior.verification !== checked.verification)
      )
        await invalidateDiagnosesForEvidence(
          tx,
          scope.studentId,
          prior.id,
          "assessment_superseded",
        );
      // The assessment and its synchronization event commit together. Model
      // calculation already happened before this short transaction.
      await this.enqueueSync(tx, scope, inserted.id);
      await tx.query(
        `UPDATE practice_submission_items
         SET latest_assessment_id=$1,grading_state=$2,mistake_sync_state=$3,
             reason_code=NULL,updated_at=now()
         WHERE attempt_id=$4 AND state='submitted'`,
        [
          inserted.id,
          checked.verification === "verified" ? "verified" : "pending",
          checked.verification === "verified" &&
          checked.correctness === "incorrect"
            ? "queued"
            : "not_required",
          a.id,
        ],
      );
    });
    if (reused)
      return {
        id: reused.id,
        attemptId: a.id,
        correctness: reused.correctness as Correctness,
        verification: reused.verification,
        hintDependency: reused.hintDependency,
        reason:
          reused.verification === "verified"
            ? "已复用已有评估"
            : "依据不足或核验不一致，暂不能可靠判定",
      };
    if (!result) throw new AppError("CONFLICT", 409, "评估未写入");
    if (this.learning?.diagnosis && checked.correctness === "incorrect") {
      await this.learning.diagnosis.analyze(scope, a.id);
    }
    if (this.learning?.profiles) {
      const skills = await this.db.pool.query<{ skill_id: string }>(
        `SELECT DISTINCT l.skill_id FROM question_bank_entries b
         JOIN question_skill_links l ON l.entry_id=b.id AND l.is_primary
         WHERE b.question_version_id=$1`,
        [a.question_version_id],
      );
      for (const { skill_id } of skills.rows) {
        await this.learning.profiles.rebuild(scope, skill_id);
      }
    }
    return {
      id: result.id,
      attemptId: a.id,
      correctness: checked.correctness,
      verification: checked.verification,
      hintDependency: dependency,
      reason:
        checked.verification === "verified"
          ? v.reason
          : "依据不足或核验不一致，暂不能可靠判定",
    };
  }
  /**
   * 提示依赖只认同一学生、同一任务、同一题目版本、且在作答之前的来源；
   * 归属不明的自由文本按 unknown 处理，不能当作独立完成。
   */
  private async hintDependency(a: {
    studentId: string;
    taskId: string | null;
    questionVersionId: string;
    messageVersionId: string | null;
    before: Date;
  }): Promise<AssessmentDTO["hintDependency"]> {
    const hints = (
      await this.db.pool.query<{ level: string }>(
        "SELECT h.level FROM hints h JOIN message_versions v ON v.id=h.message_version_id JOIN messages m ON m.id=v.message_id JOIN conversations c ON c.id=m.conversation_id WHERE h.question_version_id=$1 AND h.displayed_at<=$2 AND c.student_id=$3 AND ($4::uuid IS NULL OR c.task_id=$4)",
        [a.questionVersionId, a.before, a.studentId, a.taskId],
      )
    ).rows.map((row) => row.level);
    const actions = a.taskId
      ? (
          await this.db.pool.query<{ exposure: Exposure }>(
            "SELECT act.exposure FROM tutoring_actions act JOIN tutoring_episodes e ON e.id=act.episode_id WHERE e.student_id=$1 AND e.task_id=$2 AND e.question_version_id=$3 AND act.created_at<=$4 AND act.display_status IN ('sent','acknowledged','unknown')",
            [a.studentId, a.taskId, a.questionVersionId, a.before],
          )
        ).rows.map((row) => row.exposure)
      : [];
    return combineHintDependency({
      hints,
      actions,
      unattributed: await this.unattributedExposure(a),
    });
  }

  /** 会话里未被 hints 或 tutoring_actions 记录的教师消息，按最保守能推断的等级计入。 */
  private async unattributedExposure(a: {
    studentId: string;
    taskId: string | null;
    questionVersionId: string;
    messageVersionId: string | null;
    before: Date;
  }): Promise<Exposure> {
    if (!a.taskId) return "none";
    const rows = (
      await this.db.pool.query<{ content: string; episode_started: Date | null }>(
        `SELECT mv.content, ep.started_at AS episode_started
         FROM message_versions mv
         JOIN messages m ON m.id=mv.message_id
         JOIN conversations c ON c.id=m.conversation_id
         LEFT JOIN LATERAL (
           SELECT started_at FROM tutoring_episodes
           WHERE student_id=$1 AND task_id=$2 AND question_version_id=$3
             AND started_at <= $4
           ORDER BY started_at DESC LIMIT 1
         ) ep ON true
         WHERE c.student_id=$1 AND c.task_id=$2 AND m.role='assistant'
           AND mv.created_at <= $4
           AND NOT EXISTS (SELECT 1 FROM hints h WHERE h.message_version_id=mv.id)
           AND NOT EXISTS (SELECT 1 FROM tutoring_actions act WHERE act.message_version_id=mv.id)
         ORDER BY mv.created_at DESC LIMIT 10`,
        [a.studentId, a.taskId, a.questionVersionId, a.before],
      )
    ).rows;
    let result: Exposure = "none";
    for (const row of rows) {
      const level: Exposure = /完整解|解法如下|最终答案[:：]|答案是[:：]/.test(
        row.content,
      )
        ? "solution_exposed"
        : /提示|先写|第一步|想一想|试一试/.test(row.content)
          ? "guided"
          : row.episode_started
            ? "unknown"
            : "none";
      if (level === "solution_exposed") return level;
      if (level === "unknown" || (level === "guided" && result === "none"))
        result = level;
    }
    return result;
  }
  async listForAttempt(scope: StudentScope, attemptId: string) {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    return (
      await this.db.pool.query(
        'SELECT s.id,s.correctness,s.verification,s.hint_dependency AS "hintDependency",s.created_at AS "createdAt" FROM assessments s JOIN attempts a ON a.id=s.attempt_id WHERE a.id=$1 AND a.student_id=$2 ORDER BY s.created_at DESC',
        [attemptId, scope.studentId],
      )
    ).rows;
  }
}
