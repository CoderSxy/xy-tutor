import { createHash } from "node:crypto";
import { z } from "zod";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import {
  retrySubmissionInputSchema,
  submitPracticeInputSchema,
  type PracticeItemProgress,
  type SubmissionDTO,
  type SubmitPracticeInput,
} from "../../../../../packages/contracts/src/practice-sets.js";
import { answerPayloadSchema } from "../../../../../packages/contracts/src/question-presentation.js";
import type { AuthService } from "../auth/service.js";
import { ConversationAttachmentService } from "../conversations/attachments.js";
import { enqueueAttemptAssessment } from "../../jobs/assessment-job.js";
import { recordLearningEvent } from "../student-insights/activity.js";
import { TimingService } from "../tutoring/timing-service.js";
import {
  assertAnswerMatchesPresentation,
  PresentationValidationError,
  serializeAnswer,
  validateQuestionPresentation,
} from "../question-bank/presentation.js";
import type { PracticeSetService } from "./practice-sets.js";
import {
  loadPracticeItemProgress,
  refreshPracticeSetState,
} from "./practice-progress.js";

function hashInput(input: SubmitPracticeInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        entries: input.entries.map((entry) => ({
          itemId: entry.itemId,
          answer: entry.answer,
        })),
        skippedItemIds: [...input.skippedItemIds].sort(),
        finalize: input.finalize,
      }),
    )
    .digest("hex");
}

function notFoundAnswer(error: unknown): never {
  if (error instanceof PresentationValidationError)
    throw new AppError("NOT_FOUND", 404, error.message);
  throw error;
}

export class AnswerSubmissionService {
  constructor(
    private db: Database,
    private auth: AuthService,
    private sets: PracticeSetService,
    private timing: TimingService = new TimingService(db, auth),
    private attachments: ConversationAttachmentService = new ConversationAttachmentService(
      db,
      auth,
    ),
  ) {}

  async submit(
    scope: StudentScope,
    setId: string,
    input: unknown,
  ): Promise<SubmissionDTO> {
    const parsed = submitPracticeInputSchema.parse(input);
    const set = await this.sets.get(scope, setId);
    const task = (
      await this.db.pool.query<{ conversationId: string }>(
        `SELECT c.id AS "conversationId"
         FROM conversations c
         WHERE c.task_id=$1 AND c.student_id=$2
         ORDER BY c.created_at DESC LIMIT 1`,
        [set.taskId, scope.studentId],
      )
    ).rows[0];
    if (!task) throw new AppError("NOT_FOUND", 404, "会话不存在");
    const hash = hashInput(parsed);
    const existing = (
      await this.db.pool.query<{
        id: string;
        payload_hash: string;
      }>(
        "SELECT id, payload_hash FROM practice_submissions WHERE set_id=$1 AND request_key=$2",
        [setId, parsed.requestKey],
      )
    ).rows[0];
    if (existing) {
      if (existing.payload_hash !== hash)
        throw new AppError("CONFLICT", 409, "重复作答请求内容不同");
      return this.get(scope, existing.id);
    }
    if (set.version !== parsed.expectedVersion)
      throw new AppError("CONFLICT", 409, "题组已更新，请刷新后重试");
    if (set.generation !== "ready")
      throw new AppError("CONFLICT", 409, "题组尚未就绪");
    const bound = set.items.filter((item) => item.itemId);
    const byId = new Map(bound.map((item) => [item.itemId!, item]));
    const skipped = new Set(parsed.skippedItemIds);
    const entryIds = parsed.entries.map((entry) => entry.itemId);
    if (new Set(entryIds).size !== entryIds.length)
      throw new AppError("VALIDATION", 422, "作答题目不能重复");
    if (entryIds.some((id) => skipped.has(id)))
      throw new AppError("VALIDATION", 422, "同一题不能既作答又跳过");
    for (const id of [...entryIds, ...skipped]) {
      if (!byId.has(id)) throw new AppError("NOT_FOUND", 404, "题目不存在");
    }
    const rows = (
      await this.db.pool.query<{
        item_id: string;
        stem: string;
        question_type: string;
        presentation: unknown;
        answer_spec: unknown;
        reference_answer: string | null;
      }>(
        `SELECT i.id AS item_id, v.stem, v.question_type, v.presentation,
                v.answer_spec, v.reference_answer
         FROM task_items i JOIN question_versions v ON v.id=i.question_version_id
         WHERE i.id = ANY($1::uuid[])`,
        [entryIds],
      )
    ).rows;
    const details = new Map(rows.map((row) => [row.item_id, row]));
    for (const entry of parsed.entries) {
      const item = byId.get(entry.itemId)!;
      const detail = details.get(entry.itemId);
      if (!item.presentation || !detail)
        throw new AppError("NOT_FOUND", 404, "题目不存在");
      try {
        assertAnswerMatchesPresentation(item.presentation, entry.answer);
      } catch (error) {
        notFoundAnswer(error);
      }
    }
    const submissionId = await inTransaction(this.db, async (tx) => {
      await tx.query("SELECT id FROM practice_sets WHERE id=$1 FOR UPDATE", [
        setId,
      ]);
      const replay = (
        await tx.query<{ id: string; payload_hash: string }>(
          "SELECT id, payload_hash FROM practice_submissions WHERE set_id=$1 AND request_key=$2",
          [setId, parsed.requestKey],
        )
      ).rows[0];
      if (replay) {
        if (replay.payload_hash !== hash)
          throw new AppError("CONFLICT", 409, "重复作答请求内容不同");
        return replay.id;
      }
      if (parsed.finalize) {
        const prior = (
          await tx.query<{ task_item_id: string }>(
            `SELECT DISTINCT task_item_id FROM practice_submission_items
           WHERE task_item_id=ANY($1::uuid[]) AND state IN ('submitted','skipped')`,
            [bound.map((item) => item.itemId!)],
          )
        ).rows;
        const covered = new Set([
          ...entryIds,
          ...skipped,
          ...prior.map((item) => item.task_item_id),
        ]);
        if (bound.some((item) => !covered.has(item.itemId!)))
          throw new AppError("VALIDATION", 422, "交卷前请作答或确认跳过空题");
      }
      const submission = (
        await tx.query<{ id: string }>(
          `INSERT INTO practice_submissions(set_id,request_key,payload_hash,state)
           VALUES($1,$2,$3,'grading') RETURNING id`,
          [setId, parsed.requestKey, hash],
        )
      ).rows[0]!;
      for (const itemId of skipped) {
        const prior = (
          await tx.query<{ state: string }>(
            `SELECT state FROM practice_submission_items
             WHERE task_item_id=$1 ORDER BY created_at DESC LIMIT 1`,
            [itemId],
          )
        ).rows[0];
        if (prior?.state === "submitted")
          throw new AppError("CONFLICT", 409, "该题已作答，不能改为跳过");
        await tx.query(
          `INSERT INTO practice_submission_items(submission_id,task_item_id,state,grading_state,mistake_sync_state)
           VALUES($1,$2,'skipped','none','not_required')`,
          [submission.id, itemId],
        );
        await tx.query(
          "UPDATE task_items SET status='skipped' WHERE id=$1 AND status='pending'",
          [itemId],
        );
      }
      for (const entry of parsed.entries) {
        const item = byId.get(entry.itemId)!;
        const detail = details.get(entry.itemId)!;
        const previous = (
          await tx.query<{
            attempt_id: string | null;
            payload: unknown;
            grading_state: string;
            mistake_sync_state: string;
            latest_assessment_id: string | null;
            reason_code: string | null;
          }>(
            `SELECT psi.attempt_id, a.answer_payload AS payload, psi.grading_state, psi.mistake_sync_state, psi.latest_assessment_id, psi.reason_code
             FROM practice_submission_items psi
             LEFT JOIN attempts a ON a.id=psi.attempt_id
             WHERE psi.task_item_id=$1 AND psi.state='submitted'
             ORDER BY psi.created_at DESC LIMIT 1`,
            [entry.itemId],
          )
        ).rows[0];
        let attemptId = previous?.attempt_id ?? null;
        const same =
          previous?.payload &&
          JSON.stringify(answerPayloadSchema.parse(previous.payload)) === JSON.stringify(entry.answer);
        if (!same) {
          const validated = validateQuestionPresentation(
            {
              questionType: detail.question_type,
              stem: detail.stem,
              presentation: detail.presentation,
              answerSpec: detail.answer_spec,
              referenceAnswer: detail.reference_answer,
              rubric:
                detail.answer_spec &&
                typeof detail.answer_spec === "object" &&
                "rubric" in detail.answer_spec &&
                Array.isArray(
                  (detail.answer_spec as { rubric?: unknown }).rubric,
                )
                  ? ((detail.answer_spec as { rubric: string[] }).rubric ?? [])
                  : [],
            },
            { skipLanguage: true },
          );
          const text = serializeAnswer(validated, entry.answer);
          const message = (
            await tx.query<{ id: string }>(
              "INSERT INTO messages(conversation_id,role,request_key) VALUES($1,'user',$2) RETURNING id",
              [
                task.conversationId,
                `practice:${parsed.requestKey}:${entry.itemId}`,
              ],
            )
          ).rows[0]!;
          const version = (
            await tx.query<{ id: string }>(
              "INSERT INTO message_versions(message_id,version_no,content) VALUES($1,1,$2) RETURNING id",
              [message.id, text],
            )
          ).rows[0]!;
          if (
            entry.answer.kind === "worked" &&
            entry.answer.attachmentIds.length
          )
            await this.attachments.validateAndBind(
              tx,
              scope,
              task.conversationId,
              version.id,
              entry.answer.attachmentIds,
            );
          const attempt = (
            await tx.query<{ id: string; created_at: Date }>(
              `INSERT INTO attempts(student_id,task_id,question_version_id,message_version_id,request_key,answer,answer_payload)
               VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id, created_at`,
              [
                scope.studentId,
                set.taskId,
                item.questionVersionId,
                version.id,
                `practice:${setId}:${parsed.requestKey}:${entry.itemId}`,
                text,
                JSON.stringify(entry.answer),
              ],
            )
          ).rows[0]!;
          attemptId = attempt.id;
          await enqueueAttemptAssessment(tx, {
            attemptId: attempt.id,
            studentId: scope.studentId,
            actorId: scope.actor.userId,
            taskId: set.taskId,
          });
          await recordLearningEvent(tx, {
            studentId: scope.studentId,
            actorId: scope.actor.userId,
            eventType: "answer_submitted",
            sourceType: "attempt",
            sourceId: attempt.id,
            taskId: set.taskId,
            revisionId: null,
            occurredAt: new Date(),
            sourceOrigin: "live",
          });
          await this.timing.attachAttempt(
            tx,
            scope,
            attempt.id,
            {
              taskId: set.taskId,
              questionVersionId: item.questionVersionId!,
              createdAt: attempt.created_at,
            },
            entry.episodeId,
            entry.timingFinalEvent,
          );
        }
        await tx.query(
          `INSERT INTO practice_submission_items(submission_id,task_item_id,attempt_id,state,grading_state,mistake_sync_state,latest_assessment_id,reason_code)
           VALUES($1,$2,$3,'submitted',$4,$5,$6,$7)`,
          [
            submission.id,
            entry.itemId,
            attemptId,
            same ? previous!.grading_state : "queued",
            same ? previous!.mistake_sync_state : "not_required",
            same ? previous!.latest_assessment_id : null,
            same ? previous!.reason_code : null,
          ],
        );
        await tx.query("UPDATE task_items SET status='answered' WHERE id=$1", [
          entry.itemId,
        ]);
        await tx.query(
          "DELETE FROM practice_answer_drafts WHERE student_id=$1 AND task_item_id=$2",
          [scope.studentId, entry.itemId],
        );
      }
      await tx.query(
        "DELETE FROM practice_answer_drafts WHERE student_id=$1 AND task_item_id = ANY($2::uuid[])",
        [scope.studentId, [...skipped]],
      );
      await tx.query(
        "UPDATE practice_sets SET version=version+1, updated_at=now() WHERE id=$1",
        [setId],
      );
      await refreshPracticeSetState(tx, setId);
      return submission.id;
    });
    return this.get(scope, submissionId);
  }

  async retry(
    scope: StudentScope,
    submissionId: string,
    input: unknown,
  ): Promise<SubmissionDTO> {
    const parsed = retrySubmissionInputSchema.parse(input);
    const current = await this.get(scope, submissionId);
    const setId = current.setId;
    await this.sets.get(scope, setId);
    await inTransaction(this.db, async (tx) => {
      await tx.query("SELECT id FROM practice_sets WHERE id=$1 FOR UPDATE", [
        setId,
      ]);
      for (const itemId of parsed.itemIds) {
        const row = (
          await tx.query<{
            attempt_id: string | null;
            grading_state: string;
            mistake_sync_state: string;
            latest_assessment_id: string | null;
          }>(
            `SELECT attempt_id, grading_state, mistake_sync_state, latest_assessment_id FROM practice_submission_items
             WHERE submission_id=$1 AND task_item_id=$2`,
            [submissionId, itemId],
          )
        ).rows[0];
        if (!row) throw new AppError("NOT_FOUND", 404, "题目不存在");
        if (!row.attempt_id) continue;
        const reassess =
          row.grading_state === "failed" || row.grading_state === "pending";
        const sync =
          !reassess &&
          row.mistake_sync_state === "failed" &&
          row.latest_assessment_id;
        if (!reassess && !sync) continue;
        const kind = reassess ? "learning.assess" : "learning.mistake-sync";
        const payload = reassess
          ? {
              attemptId: row.attempt_id,
              studentId: scope.studentId,
              actorId: scope.actor.userId,
              forceReassessment: true,
            }
          : {
              assessmentId: row.latest_assessment_id,
              studentId: scope.studentId,
              actorId: scope.actor.userId,
            };
        const identity = reassess ? row.attempt_id : row.latest_assessment_id;
        await tx.query(
          `INSERT INTO jobs(kind,dedupe_key,payload) VALUES($1,$2,$3::jsonb)
           ON CONFLICT(dedupe_key) DO UPDATE SET status='queued',attempts=0,available_at=now(),
             lease_token=NULL,lease_expires_at=NULL,error_code=NULL,payload=EXCLUDED.payload
           WHERE jobs.status IN ('failed','completed')`,
          [kind, `${kind}:${identity}`, JSON.stringify(payload)],
        );
        if (reassess)
          await tx.query(
            `UPDATE practice_submission_items SET grading_state='queued', reason_code=NULL, updated_at=now()
             WHERE attempt_id=$1 AND grading_state IN ('failed','pending')`,
            [row.attempt_id],
          );
        else
          await tx.query(
            `UPDATE practice_submission_items SET mistake_sync_state='queued', reason_code=NULL, updated_at=now()
             WHERE attempt_id=$1 AND mistake_sync_state='failed'`,
            [row.attempt_id],
          );
      }
      await refreshPracticeSetState(tx, setId);
    });
    return this.get(scope, submissionId);
  }

  async get(scope: StudentScope, submissionId: string): Promise<SubmissionDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    z.uuid().parse(submissionId);
    const row = (
      await this.db.pool.query<{
        id: string;
        set_id: string;
        state: SubmissionDTO["state"];
        student_id: string;
      }>(
        `SELECT s.id, s.set_id, s.state, t.student_id
         FROM practice_submissions s
         JOIN practice_sets p ON p.id=s.set_id
         JOIN learning_tasks t ON t.id=p.task_id
         WHERE s.id=$1`,
        [submissionId],
      )
    ).rows[0];
    if (!row || row.student_id !== scope.studentId)
      throw new AppError("NOT_FOUND", 404, "作答记录不存在");
    const items = (
      await this.db.pool.query<{
        task_item_id: string;
        state: "submitted" | "skipped";
        grading_state: PracticeItemProgress["grading"];
        mistake_sync_state: PracticeItemProgress["mistakeSync"];
        correctness: PracticeItemProgress["correctness"];
      }>(
        `SELECT psi.task_item_id, psi.state, psi.grading_state,
                psi.mistake_sync_state, a.correctness
         FROM practice_submission_items psi
         LEFT JOIN assessments a ON a.id=psi.latest_assessment_id
         WHERE psi.submission_id=$1
         ORDER BY psi.created_at, psi.id`,
        [submissionId],
      )
    ).rows;
    const progress = await loadPracticeItemProgress(this.db.pool, row.set_id);
    const aggregated = progress.length
      ? progress
      : items.map((item) => ({
          itemId: item.task_item_id,
          submission: item.state,
          grading: item.grading_state,
          correctness: item.correctness ?? null,
          mistakeSync: item.mistake_sync_state,
        }));
    const scoped = aggregated.filter((item) =>
      items.some((rowItem) => rowItem.task_item_id === item.itemId),
    );
    const stateItems = scoped.length
      ? scoped
      : items.map((item) => ({
          itemId: item.task_item_id,
          submission: item.state,
          grading: item.grading_state,
          correctness: item.correctness ?? null,
          mistakeSync: item.mistake_sync_state,
        }));
    const pending = stateItems.some((item) => item.grading === "pending");
    const failed = stateItems.some((item) => item.grading === "failed");
    const queued = stateItems.some(
      (item) => item.grading === "queued" || item.grading === "running",
    );
    const verified = stateItems.filter(
      (item) =>
        item.submission === "skipped" ||
        (item.submission === "submitted" && item.grading === "verified"),
    ).length;
    let state: SubmissionDTO["state"] = "grading";
    if (pending) state = "needs_review";
    else if (
      !queued &&
      !failed &&
      verified === stateItems.length &&
      stateItems.length
    )
      state = "completed";
    return {
      id: row.id,
      setId: row.set_id,
      state,
      items: stateItems,
    };
  }
}
