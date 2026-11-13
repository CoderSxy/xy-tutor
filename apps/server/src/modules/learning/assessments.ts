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
    const hints = (
      await this.db.pool.query(
        "SELECT level FROM hints WHERE question_version_id=$1 AND displayed_at<=$2",
        [a.question_version_id, a.created_at],
      )
    ).rows;
    const dependency: AssessmentDTO["hintDependency"] = !a.message_version_id
      ? "unknown"
      : hints.some((h) => h.level === "solution_exposed")
        ? "solution_exposed"
        : hints.length
          ? "guided"
          : "none";
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
