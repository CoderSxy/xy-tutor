import { createHash } from "node:crypto";
import { z } from "zod";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import {
  changeModeInputSchema,
  continueInputSchema,
  practiceSetCreateInputSchema,
  type ContinueResult,
  type PracticeItemDTO,
  type PracticeSetDTO,
} from "../../../../../packages/contracts/src/practice-sets.js";
import type { AuthService } from "../auth/service.js";
import type { TaskService } from "./tasks.js";
import { enqueueJob, type JobQueue } from "../../jobs/queue.js";
import { buildBlueprint } from "./practice-blueprint.js";
import { instantiateTemplate } from "../question-bank/templates.js";
import { toPublicQuestion } from "../question-bank/presentation.js";
import type { QuestionType } from "../../../../../packages/contracts/src/question-presentation.js";
import {
  computePracticeProgress,
  loadPracticeItemProgress,
} from "./practice-progress.js";
import { searchEligibleQuestions } from "../question-bank/search.js";
import {
  targetDifficulty,
  type RecentDecision,
} from "../learning-profile/selection-policy.js";
import { getExamProfile } from "../question-bank/exam-profiles.js";

const TEMPLATE_FORMS: Record<
  string,
  "single_choice" | "fill_blank" | "worked"
> = {
  single_choice: "single_choice",
  fill_blank: "fill_blank",
  worked: "worked",
};

type ScopeSnapshot = {
  skillIds: string[];
  confirmed: boolean;
  excludeVersionIds?: string[];
};

export class PracticeSetService {
  constructor(
    private db: Database,
    private auth: AuthService,
    private tasks: TaskService,
    private jobs?: JobQueue,
    private flags: { practiceSetsEnabled?: boolean } = {},
  ) {}

  async create(
    scope: StudentScope,
    taskId: string,
    input: unknown,
  ): Promise<PracticeSetDTO> {
    await this.tasks.resume(scope, taskId);
    const parsed = practiceSetCreateInputSchema.parse(input);
    this.assertExamProfile(parsed.strategy, parsed.examProfileId);
    const knowledge = await this.validSkills(parsed.skillIds ?? []);
    return inTransaction(this.db, async (tx) => {
      await tx.query("SELECT id FROM learning_tasks WHERE id=$1 FOR UPDATE", [
        taskId,
      ]);
      const existing = (
        await tx.query<{ id: string }>(
          "SELECT id FROM practice_sets WHERE task_id=$1",
          [taskId],
        )
      ).rows[0];
      if (existing) return this.load(tx, existing.id);
      if (this.flags.practiceSetsEnabled === false)
        throw new AppError("CONFLICT", 409, "题组练习尚未开放");
      const confirmed = knowledge.length > 0;
      const seed = createHash("sha256")
        .update(`${taskId}:${parsed.requestKey}`)
        .digest("hex");
      const examProfile =
        parsed.strategy === "exam" && parsed.examProfileId
          ? getExamProfile(parsed.examProfileId, undefined, {
              includeFixtures: process.env.NODE_ENV === "test",
            })
          : undefined;
      const blueprint = buildBlueprint({
        strategy: parsed.strategy,
        seed,
        examProfile,
      });
      const generation = confirmed ? "preparing" : "awaiting_scope";
      const set = (
        await tx.query<{ id: string }>(
          `INSERT INTO practice_sets(task_id,mode,strategy,exam_profile_id,policy_version,seed,scope_snapshot,blueprint,generation_status,version)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,1) RETURNING id`,
          [
            taskId,
            parsed.mode,
            parsed.strategy,
            parsed.examProfileId ?? null,
            blueprint.policyVersion,
            seed,
            JSON.stringify({
              skillIds: knowledge,
              confirmed,
            } satisfies ScopeSnapshot),
            JSON.stringify({ ...blueprint, attempts: 0 }),
            generation,
          ],
        )
      ).rows[0]!;
      for (const slot of blueprint.slots) {
        await tx.query(
          `INSERT INTO practice_set_slots(set_id,position,question_type,state)
           VALUES($1,$2,$3,'pending')`,
          [set.id, slot.position, slot.questionType],
        );
      }
      if (confirmed && this.jobs)
        await enqueueJob(tx, {
          kind: "learning.practice-set",
          dedupeKey: `learning.practice-set:${set.id}`,
          payload: {
            setId: set.id,
            studentId: scope.studentId,
            actorId: scope.actor.userId,
          },
        });
      return this.load(tx, set.id);
    });
  }

  async get(scope: StudentScope, setId: string): Promise<PracticeSetDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    z.uuid().parse(setId);
    const dto = await this.load(this.db.pool, setId);
    const task = (
      await this.db.pool.query<{ student_id: string }>(
        "SELECT t.student_id FROM practice_sets s JOIN learning_tasks t ON t.id=s.task_id WHERE s.id=$1",
        [setId],
      )
    ).rows[0];
    if (!task || task.student_id !== scope.studentId)
      throw new AppError("NOT_FOUND", 404, "题组不存在");
    return dto;
  }

  async getByTask(
    scope: StudentScope,
    taskId: string,
  ): Promise<PracticeSetDTO | null> {
    await this.tasks.resume(scope, taskId);
    const row = (
      await this.db.pool.query<{ id: string }>(
        "SELECT id FROM practice_sets WHERE task_id=$1",
        [taskId],
      )
    ).rows[0];
    return row ? this.get(scope, row.id) : null;
  }

  async retryGeneration(
    scope: StudentScope,
    setId: string,
    input: { requestKey: string; expectedVersion: number; skillIds?: string[] },
  ): Promise<PracticeSetDTO> {
    const current = await this.get(scope, setId);
    if (current.version !== input.expectedVersion)
      throw new AppError("CONFLICT", 409, "题组已更新，请刷新后重试");
    const skillIds = input.skillIds
      ? await this.validSkills(input.skillIds)
      : null;
    if (skillIds && current.items.some((item) => item.itemId)) {
      const snapshot = (
        await this.db.pool.query<{ scope_snapshot: ScopeSnapshot }>(
          "SELECT scope_snapshot FROM practice_sets WHERE id=$1",
          [setId],
        )
      ).rows[0]!;
      if (
        JSON.stringify([...snapshot.scope_snapshot.skillIds].sort()) !==
        JSON.stringify([...skillIds].sort())
      )
        throw new AppError("CONFLICT", 409, "已有题目，不能更换本题组范围");
    }
    await this.db.pool.query(
      `UPDATE practice_sets SET generation_status=CASE WHEN $2::jsonb IS NOT NULL THEN 'preparing' WHEN scope_snapshot->>'confirmed'='true' THEN 'preparing' ELSE generation_status END,
       scope_snapshot=CASE WHEN $2::jsonb IS NOT NULL THEN scope_snapshot || $2::jsonb ELSE scope_snapshot END,
       blueprint=blueprint || '{"attempts":0}'::jsonb, version=version+1,updated_at=now()
       WHERE id=$1 AND generation_status IN ('awaiting_scope','failed','insufficient_pool','preparing')`,
      [
        setId,
        skillIds?.length ? JSON.stringify({ skillIds, confirmed: true }) : null,
      ],
    );
    await this.db.pool.query(
      "UPDATE practice_set_slots SET state='pending',reason_code=NULL WHERE set_id=$1 AND state='failed'",
      [setId],
    );
    if (this.jobs)
      await enqueueJob(this.db.pool, {
        kind: "learning.practice-set",
        dedupeKey: `learning.practice-set:${setId}:retry:${input.requestKey}`,
        payload: {
          setId,
          studentId: scope.studentId,
          actorId: scope.actor.userId,
        },
      });
    return this.get(scope, setId);
  }

  async fillSlot(
    scope: StudentScope,
    setId: string,
    position: number,
  ): Promise<PracticeSetDTO> {
    await this.get(scope, setId);
    await this.fillOne(setId, position, scope);
    return this.get(scope, setId);
  }

  async generateAll(
    scope: StudentScope,
    setId: string,
  ): Promise<PracticeSetDTO> {
    const set = (
      await this.db.pool.query<{
        blueprint: { attempts?: number; slots: { position: number }[] };
        generation_status: string;
      }>("SELECT blueprint,generation_status FROM practice_sets WHERE id=$1", [
        setId,
      ])
    ).rows[0];
    if (!set) throw new AppError("NOT_FOUND", 404, "题组不存在");
    if (set.generation_status === "awaiting_scope")
      return this.get(scope, setId);
    let attempts = set.blueprint.attempts ?? 0;
    const slots = (
      await this.db.pool.query<{
        position: number;
        state: string;
        tries: number;
      }>(
        `SELECT position,state,COALESCE((SELECT count(*) FROM task_items i WHERE i.id=practice_set_slots.task_item_id),0)::int AS tries
         FROM practice_set_slots WHERE set_id=$1 ORDER BY position`,
        [setId],
      )
    ).rows;
    for (const slot of slots) {
      if (slot.state === "bound") continue;
      let tries = 0;
      while (tries < 2 && attempts < 10) {
        attempts += 1;
        tries += 1;
        const bound = await this.fillOne(setId, slot.position, scope);
        if (bound) break;
      }
      if (attempts >= 10) break;
    }
    await this.db.pool.query(
      `UPDATE practice_sets SET blueprint = blueprint || jsonb_build_object('attempts',$2::int),
         generation_status=$3, updated_at=now()
       WHERE id=$1`,
      [setId, attempts, await this.projectGeneration(setId, attempts)],
    );
    return this.get(scope, setId);
  }

  async markFailed(setId: string): Promise<void> {
    await this.db.pool.query(
      "UPDATE practice_sets SET generation_status='failed',updated_at=now() WHERE id=$1 AND generation_status IN ('preparing','failed')",
      [setId],
    );
  }

  async changeMode(
    scope: StudentScope,
    setId: string,
    input: unknown,
  ): Promise<PracticeSetDTO> {
    const parsed = changeModeInputSchema.parse(input);
    const current = await this.get(scope, setId);
    if (current.version !== parsed.expectedVersion)
      throw new AppError("CONFLICT", 409, "题组已更新，请刷新后重试");
    const updated = await this.db.pool.query(
      `UPDATE practice_sets SET mode=$2, version=version+1, updated_at=now()
       WHERE id=$1 AND version=$3 RETURNING id`,
      [setId, parsed.mode, parsed.expectedVersion],
    );
    if (!updated.rowCount)
      throw new AppError("CONFLICT", 409, "题组已更新，请刷新后重试");
    return this.get(scope, setId);
  }

  async results(scope: StudentScope, setId: string) {
    const set = await this.get(scope, setId);
    const hide = set.mode === "batch" && set.submission === "open";
    const reasons = hide
      ? []
      : (
          await this.db.pool.query<{
            item_id: string;
            reason: string | null;
          }>(
            `SELECT sl.task_item_id AS item_id, a.evidence->>'reason' AS reason
             FROM practice_set_slots sl
             JOIN LATERAL (
               SELECT psi.latest_assessment_id
               FROM practice_submission_items psi
               WHERE psi.task_item_id=sl.task_item_id
               ORDER BY psi.created_at DESC LIMIT 1
             ) psi ON true
             LEFT JOIN assessments a ON a.id=psi.latest_assessment_id
             WHERE sl.set_id=$1`,
            [setId],
          )
        ).rows;
    const reasonByItem = new Map(
      reasons.map((row) => [row.item_id, row.reason]),
    );
    return {
      setId,
      items: set.items.map((item) => ({
        itemId: item.itemId,
        position: item.position,
        correctness: hide ? null : item.progress.correctness,
        reason: hide ? null : (reasonByItem.get(item.itemId ?? "") ?? null),
      })),
    };
  }

  async continue(
    scope: StudentScope,
    setId: string,
    input: unknown,
  ): Promise<ContinueResult> {
    const parsed = continueInputSchema.parse(input);
    const hash = createHash("sha256")
      .update(JSON.stringify({ requestKey: parsed.requestKey }))
      .digest("hex");
    await this.get(scope, setId);
    const existing = await this.findContinuation(setId);
    if (existing)
      return this.replayContinuation(existing, parsed.requestKey, hash);
    return inTransaction(this.db, async (tx) => {
      await tx.query("SELECT id FROM practice_sets WHERE id=$1 FOR UPDATE", [
        setId,
      ]);
      const locked = await this.findContinuation(setId, tx);
      if (locked)
        return this.replayContinuation(locked, parsed.requestKey, hash);
      const current = await this.load(tx, setId);
      if (!current.canContinue)
        throw new AppError("CONFLICT", 409, "题组尚未完成，不能再来五题");
      if (current.version !== parsed.expectedVersion)
        throw new AppError("CONFLICT", 409, "题组已更新，请刷新后重试");
      if (this.flags.practiceSetsEnabled === false)
        throw new AppError("CONFLICT", 409, "题组练习尚未开放");
      this.assertExamProfile(current.strategy, current.examProfileId);
      const previous = (
        await tx.query<{
          student_id: string;
          revision_id: string | null;
          kind: string;
          chapter_id: string | null;
          scope_snapshot: ScopeSnapshot;
        }>(
          `SELECT t.student_id, t.revision_id, t.kind, t.chapter_id, s.scope_snapshot
           FROM practice_sets s JOIN learning_tasks t ON t.id=s.task_id
           WHERE s.id=$1`,
          [setId],
        )
      ).rows[0]!;
      const excludeVersionIds = [
        ...(previous.scope_snapshot.excludeVersionIds ?? []),
        ...current.items
          .map((item) => item.questionVersionId)
          .filter((id): id is string => !!id),
      ];
      const task = (
        await tx.query<{ id: string }>(
          `INSERT INTO learning_tasks(student_id,revision_id,kind,chapter_id)
           VALUES($1,$2,$3,$4) RETURNING id`,
          [
            previous.student_id,
            previous.revision_id,
            previous.kind,
            previous.chapter_id,
          ],
        )
      ).rows[0]!;
      const conversation = (
        await tx.query<{ id: string }>(
          `INSERT INTO conversations(student_id,task_id,revision_id)
           VALUES($1,$2,$3) RETURNING id`,
          [previous.student_id, task.id, previous.revision_id],
        )
      ).rows[0]!;
      const seed = createHash("sha256")
        .update(`${task.id}:${parsed.requestKey}`)
        .digest("hex");
      const examProfile =
        current.strategy === "exam" && current.examProfileId
          ? getExamProfile(current.examProfileId, undefined, {
              includeFixtures: process.env.NODE_ENV === "test",
            })
          : undefined;
      const blueprint = buildBlueprint({
        strategy: current.strategy,
        seed,
        examProfile,
      });
      const confirmed = (previous.scope_snapshot.skillIds ?? []).length > 0;
      const created = (
        await tx.query<{ id: string }>(
          `INSERT INTO practice_sets(task_id,mode,strategy,exam_profile_id,policy_version,seed,scope_snapshot,blueprint,generation_status,previous_set_id,version)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,1) RETURNING id`,
          [
            task.id,
            current.mode,
            current.strategy,
            current.examProfileId,
            blueprint.policyVersion,
            seed,
            JSON.stringify({
              skillIds: previous.scope_snapshot.skillIds ?? [],
              confirmed,
              excludeVersionIds,
            } satisfies ScopeSnapshot),
            JSON.stringify({ ...blueprint, attempts: 0 }),
            confirmed ? "preparing" : "awaiting_scope",
            setId,
          ],
        )
      ).rows[0]!;
      for (const slot of blueprint.slots) {
        await tx.query(
          `INSERT INTO practice_set_slots(set_id,position,question_type,state)
           VALUES($1,$2,$3,'pending')`,
          [created.id, slot.position, slot.questionType],
        );
      }
      await tx.query(
        `INSERT INTO practice_set_continuations(previous_set_id,request_key,payload_hash,new_set_id)
         VALUES($1,$2,$3,$4)`,
        [setId, parsed.requestKey, hash, created.id],
      );
      if (confirmed && this.jobs)
        await enqueueJob(tx, {
          kind: "learning.practice-set",
          dedupeKey: `learning.practice-set:${created.id}`,
          payload: {
            setId: created.id,
            studentId: scope.studentId,
            actorId: scope.actor.userId,
          },
        });
      return {
        taskId: task.id,
        setId: created.id,
        conversationId: conversation.id,
      };
    });
  }

  private assertExamProfile(
    strategy: PracticeSetDTO["strategy"],
    examProfileId: string | null | undefined,
  ) {
    if (strategy !== "exam") return;
    if (
      !examProfileId ||
      !getExamProfile(examProfileId, undefined, {
        includeFixtures: process.env.NODE_ENV === "test",
      })
    )
      throw new AppError(
        "VALIDATION",
        422,
        "考试配置无效或已失效，请选择替代配置",
      );
  }

  private async findContinuation(
    setId: string,
    queryable: {
      query: (
        sql: string,
        params?: unknown[],
      ) => Promise<{ rows: Record<string, unknown>[] }>;
    } = this.db.pool,
  ) {
    return (
      await queryable.query(
        `SELECT request_key, payload_hash, new_set_id
         FROM practice_set_continuations WHERE previous_set_id=$1`,
        [setId],
      )
    ).rows[0] as
      | { request_key: string; payload_hash: string; new_set_id: string }
      | undefined;
  }

  private async replayContinuation(
    existing: { request_key: string; payload_hash: string; new_set_id: string },
    requestKey: string,
    hash: string,
  ): Promise<ContinueResult> {
    if (existing.request_key === requestKey && existing.payload_hash !== hash)
      throw new AppError("CONFLICT", 409, "重复继续请求内容不同");
    const created = await this.load(this.db.pool, existing.new_set_id);
    const conversation = (
      await this.db.pool.query<{ id: string }>(
        `SELECT id FROM conversations WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [created.taskId],
      )
    ).rows[0];
    if (!conversation) throw new AppError("NOT_FOUND", 404, "会话不存在");
    return {
      taskId: created.taskId,
      setId: created.id,
      conversationId: conversation.id,
    };
  }

  private async fillOne(
    setId: string,
    position: number,
    scope: StudentScope,
  ): Promise<boolean> {
    // A set lock serializes candidate selection across slots and workers, so duplicate
    // content cannot be bound twice by concurrent fill requests.
    return inTransaction(this.db, async (tx) => {
      const set = (
        await tx.query<{
          task_id: string;
          seed: string;
          scope_snapshot: ScopeSnapshot;
        }>(
          "SELECT task_id,seed,scope_snapshot FROM practice_sets WHERE id=$1 FOR UPDATE",
          [setId],
        )
      ).rows[0];
      if (!set?.scope_snapshot.confirmed) return false;
      const slot = (
        await tx.query<{
          id: string;
          question_type: QuestionType;
          state: string;
        }>(
          "SELECT id,question_type,state FROM practice_set_slots WHERE set_id=$1 AND position=$2 FOR UPDATE",
          [setId, position],
        )
      ).rows[0];
      if (!slot || slot.state === "bound") return slot?.state === "bound";
      const skills = await this.validSkills(set.scope_snapshot.skillIds);
      const excluded = (
        await tx.query<{ id: string; stem: string }>(
          `SELECT DISTINCT v.id,v.stem FROM question_versions v
         LEFT JOIN task_items i ON i.question_version_id=v.id
         LEFT JOIN learning_tasks t ON t.id=i.task_id
         WHERE v.id=ANY($1::uuid[]) OR (t.student_id=$2 AND (t.id=$3 OR t.created_at > now()-interval '30 days'))`,
          [
            set.scope_snapshot.excludeVersionIds ?? [],
            scope.studentId,
            set.task_id,
          ],
        )
      ).rows;
      const normalize = (stem: string) =>
        stem.normalize("NFKC").replace(/\s+/g, "").trim();
      const excludedStems = new Set(excluded.map((v) => normalize(v.stem)));
      const ranked = [];
      for (const skillId of skills) {
        const profile = (
          await tx.query<{
            training_band: "repair" | "consolidation" | "advance";
          }>(
            "SELECT training_band FROM learning_profiles WHERE student_id=$1 AND skill_id=$2",
            [scope.studentId, skillId],
          )
        ).rows[0];
        const recent = (
          await tx.query<RecentDecision>(
            `SELECT goal,difficulty,question_version_id AS "questionVersionId" FROM practice_decisions WHERE student_id=$1 AND skill_id=$2 ORDER BY created_at DESC LIMIT 20`,
            [scope.studentId, skillId],
          )
        ).rows.reverse();
        const desired = targetDifficulty(
          profile?.training_band ?? "repair",
          recent,
        );
        const candidates = await searchEligibleQuestions(
          tx,
          scope,
          {
            skillId,
            goal: profile?.training_band === "advance" ? "transfer" : "repair",
            answerType: slot.question_type,
            limit: 50,
          },
          { databaseExcludedVersionIds: excluded.map((v) => v.id) },
        );
        for (const candidate of candidates)
          ranked.push({
            ...candidate,
            preferred: candidate.difficulty === desired,
          });
      }
      ranked.sort(
        (a, b) =>
          Number(b.preferred) - Number(a.preferred) ||
          b.matchedCauseCount - a.matchedCauseCount ||
          a.seenCount - b.seenCount ||
          createHash("sha256")
            .update(set.seed + a.questionVersionId)
            .digest("hex")
            .localeCompare(
              createHash("sha256")
                .update(set.seed + b.questionVersionId)
                .digest("hex"),
            ),
      );
      let versionId: string | undefined;
      for (const candidate of ranked) {
        const v = (
          await tx.query<{ stem: string; question_type: string }>(
            "SELECT stem,question_type FROM question_versions WHERE id=$1",
            [candidate.questionVersionId],
          )
        ).rows[0];
        if (
          v?.question_type === slot.question_type &&
          !excludedStems.has(normalize(v.stem))
        ) {
          versionId = candidate.questionVersionId;
          break;
        }
      }
      if (!versionId) {
        const templates = (
          await tx.query<{ family: string; version: number }>(
            `SELECT family,version FROM question_templates WHERE skill_id=ANY($1::uuid[]) AND status='approved' AND approved_at IS NOT NULL AND approved_by IS NOT NULL ORDER BY family`,
            [skills],
          )
        ).rows;
        let generated;
        for (let variant = 0; variant < 64 && !generated; variant++) {
          for (const template of templates) {
            if (!TEMPLATE_FORMS[slot.question_type]) continue;
            const bytes = createHash("sha256")
              .update(`${set.seed}:${position}:${variant}:${template.family}`)
              .digest();
            try {
              const candidate = instantiateTemplate(
                template.family,
                template.version,
                {
                  a: 1 + (bytes[0]! % 19),
                  b: 1 + (bytes[1]! % 17),
                  c: 1 + (bytes[2]! % 29),
                  d: 1 + (bytes[3]! % 19),
                  op: bytes[4]! % 2 ? "+" : "-",
                  form: TEMPLATE_FORMS[slot.question_type],
                },
              );
              if (
                candidate.questionType === slot.question_type &&
                !excludedStems.has(normalize(candidate.stem))
              ) {
                generated = candidate;
                break;
              }
            } catch {
              /* Unsupported or withdrawn template versions cannot fill this slot. */
            }
          }
        }
        if (generated) {
          const question = (
            await tx.query<{ id: string }>(
              "INSERT INTO questions(student_id,source_type) VALUES($1,'practice') RETURNING id",
              [scope.studentId],
            )
          ).rows[0]!;
          versionId = (
            await tx.query<{ id: string }>(
              `INSERT INTO question_versions(question_id,version_no,stem,reference_answer,question_type,presentation,answer_spec,verification,language_status)
             VALUES($1,1,$2,$3,$4,$5::jsonb,$6::jsonb,'verified','accepted') RETURNING id`,
              [
                question.id,
                generated.stem,
                generated.answer,
                generated.questionType,
                JSON.stringify(generated.presentation ?? {}),
                JSON.stringify(generated.answerSpec ?? {}),
              ],
            )
          ).rows[0]!.id;
          await tx.query(
            `INSERT INTO question_references(question_version_id,answer,answer_type,requires_working,verification,evidence)
             VALUES($1,$2,$3,$4,'verified',$5::jsonb)`,
            [
              versionId,
              generated.answer,
              generated.answerType,
              generated.questionType === "worked",
              JSON.stringify({ source: "approved_template", seed: set.seed }),
            ],
          );
        }
      }
      if (!versionId) {
        await tx.query(
          "UPDATE practice_set_slots SET state='failed',reason_code='insufficient_pool',updated_at=now() WHERE id=$1",
          [slot.id],
        );
        return false;
      }
      const item = (
        await tx.query<{ id: string }>(
          "INSERT INTO task_items(task_id,question_version_id,position,role) VALUES($1,$2,$3,'original') RETURNING id",
          [set.task_id, versionId, position],
        )
      ).rows[0]!;
      await tx.query(
        "UPDATE practice_set_slots SET task_item_id=$2,state='bound',reason_code=NULL,updated_at=now() WHERE id=$1",
        [slot.id, item.id],
      );
      return true;
    });
  }

  private async projectGeneration(setId: string, attempts: number) {
    const slots = (
      await this.db.pool.query<{ state: string }>(
        "SELECT state FROM practice_set_slots WHERE set_id=$1",
        [setId],
      )
    ).rows;
    const bound = slots.filter((slot) => slot.state === "bound").length;
    if (bound === 5) return "ready";
    if (attempts >= 10 || slots.every((slot) => slot.state !== "pending"))
      return "insufficient_pool";
    return "preparing";
  }

  async listScopes(
    scope: StudentScope,
  ): Promise<Array<{ id: string; name: string }>> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    return (
      await this.db.pool.query<{ id: string; name: string }>(
        `SELECT s.id,s.name FROM skills s WHERE s.status='active' AND EXISTS (
       SELECT 1 FROM skill_content_links l JOIN knowledge_items k ON k.id=l.knowledge_item_id
       WHERE l.skill_id=s.id AND k.status='published') AND NOT EXISTS (
       SELECT 1 FROM skill_prerequisites p WHERE p.skill_id=s.id AND NOT EXISTS (
         SELECT 1 FROM skill_content_links l JOIN knowledge_items k ON k.id=l.knowledge_item_id
         JOIN skills prerequisite ON prerequisite.id=l.skill_id AND prerequisite.status='active'
         WHERE l.skill_id=p.prerequisite_id AND k.status='published')) ORDER BY s.name,s.id`,
      )
    ).rows;
  }

  private async validSkills(ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const rows = (
      await this.db.pool.query<{ id: string }>(
        `SELECT s.id FROM skills s WHERE s.id=ANY($1::uuid[]) AND s.status='active' AND EXISTS (
       SELECT 1 FROM skill_content_links l JOIN knowledge_items k ON k.id=l.knowledge_item_id
       WHERE l.skill_id=s.id AND k.status='published') AND NOT EXISTS (
       SELECT 1 FROM skill_prerequisites p WHERE p.skill_id=s.id AND NOT EXISTS (
         SELECT 1 FROM skill_content_links l JOIN knowledge_items k ON k.id=l.knowledge_item_id
         JOIN skills prerequisite ON prerequisite.id=l.skill_id AND prerequisite.status='active'
         WHERE l.skill_id=p.prerequisite_id AND k.status='published')) ORDER BY s.id`,
        [ids],
      )
    ).rows;
    if (rows.length !== new Set(ids).size)
      throw new AppError(
        "VALIDATION",
        422,
        "所选范围尚未发布或已失效，请重新选择",
      );
    return rows.map((r) => r.id);
  }

  private async load(
    queryable: {
      query: (
        sql: string,
        params?: unknown[],
      ) => Promise<{ rows: Record<string, unknown>[] }>;
    },
    setId: string,
  ): Promise<PracticeSetDTO> {
    const set = (
      await queryable.query(
        `SELECT s.id,s.task_id AS "taskId",s.version,s.mode,s.strategy,s.exam_profile_id AS "examProfileId",
                s.generation_status AS generation,s.submission_status AS submission
         FROM practice_sets s WHERE s.id=$1`,
        [setId],
      )
    ).rows[0];
    if (!set) throw new AppError("NOT_FOUND", 404, "题组不存在");
    const slots = (
      await queryable.query(
        `SELECT sl.id AS "slotId",sl.position,sl.question_type AS "questionType",sl.task_item_id AS "itemId",
                sl.state,sl.reason_code AS "reasonCode",i.question_version_id AS "questionVersionId",
                v.stem,v.presentation,v.answer_spec AS "answerSpec",v.knowledge_point AS "knowledgePoint"
         FROM practice_set_slots sl
         LEFT JOIN task_items i ON i.id=sl.task_item_id
         LEFT JOIN question_versions v ON v.id=i.question_version_id
         WHERE sl.set_id=$1 ORDER BY sl.position`,
        [setId],
      )
    ).rows as Array<{
      slotId: string;
      position: number;
      questionType: QuestionType;
      itemId: string | null;
      questionVersionId: string | null;
      stem: string | null;
      presentation: unknown;
      answerSpec: unknown;
      knowledgePoint: string | null;
      reasonCode: string | null;
    }>;
    const progressItems = await loadPracticeItemProgress(queryable, setId);
    const progressByItem = new Map(
      progressItems.map((item) => [item.itemId, item]),
    );
    const items: PracticeItemDTO[] = slots.map((slot) => {
      const publicQuestion =
        slot.questionVersionId && slot.stem
          ? toPublicQuestion({
              id: slot.questionVersionId,
              stem: slot.stem,
              questionType: slot.questionType,
              knowledgePoint: slot.knowledgePoint,
              presentation: slot.presentation,
              answerSpec: slot.answerSpec,
            })
          : null;
      const progress = progressByItem.get(slot.itemId ?? slot.slotId) ?? {
        itemId: slot.itemId ?? slot.slotId,
        submission: "unanswered" as const,
        grading: "none" as const,
        correctness: null,
        mistakeSync: "not_required" as const,
      };
      return {
        slotId: slot.slotId,
        position: slot.position,
        questionType: slot.questionType,
        itemId: slot.itemId,
        questionVersionId: slot.questionVersionId,
        stem: publicQuestion?.stem ?? null,
        presentation: publicQuestion?.presentation ?? null,
        progress,
        reasonCode: slot.reasonCode,
      };
    });
    const computed = computePracticeProgress({
      items: items.map((item) => item.progress),
    });
    return {
      id: set.id as string,
      taskId: set.taskId as string,
      version: set.version as number,
      mode: set.mode as PracticeSetDTO["mode"],
      strategy: set.strategy as PracticeSetDTO["strategy"],
      examProfileId: (set.examProfileId as string | null) ?? null,
      generation: set.generation as PracticeSetDTO["generation"],
      submission: computed.submission,
      counts: computed.counts,
      canContinue: computed.canContinue,
      items,
    };
  }
}
