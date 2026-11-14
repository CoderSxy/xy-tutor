import { z } from "zod";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Database } from "../../../../../packages/db/src/client.js";
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
  async submitCandidate(
    scope: StudentScope,
    input: unknown,
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
          AbortSignal.timeout(60000),
        );
        const reference = referenceSchema.parse(parseModelJson(generated.text));
        const checked = await checkReference(this.gateway, a.stem, reference);
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
          AbortSignal.timeout(60000),
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
    const prior = (
      await this.db.pool.query<{
        id: string;
        correctness: string;
        verification: string;
      }>(
        "SELECT id,correctness,verification FROM assessments WHERE attempt_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
        [a.id],
      )
    ).rows[0];
    const result = (
      await this.db.pool.query(
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
    if (
      prior &&
      (prior.correctness !== checked.correctness ||
        prior.verification !== checked.verification)
    )
      await invalidateDiagnosesForEvidence(
        this.db.pool,
        scope.studentId,
        prior.id,
        "assessment_superseded",
      );
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
