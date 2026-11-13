import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import {
  questionGenerationRequestSchema,
  type QuestionGenerationRequestInput,
} from "../../../../../packages/contracts/src/question-bank.js";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { ModelGateway } from "../../agent/provider.js";
import { parseModelJson } from "../learning/practice.js";
import type { JobQueue } from "../../jobs/queue.js";
import {
  instantiateTemplate,
  type TemplateValidationError,
} from "./templates.js";
import {
  verifyBankCandidate,
  type BankVerification,
  type FrozenKnowledge,
} from "./verifier.js";

type RunRow = {
  id: string;
  skill_id: string;
  template_id: string | null;
  status: string;
  requested_by: string;
  student_id: string | null;
  visibility: string;
  request_key: string;
  dedupe_key: string;
  params: {
    templateCode?: string;
    templateVersion?: number;
    goal?: string;
    params?: Record<string, unknown>;
  };
  result_entry_id: string | null;
  error_code: string | null;
};

type TemplateRow = {
  id: string;
  family: string;
  skill_id: string | null;
  difficulty_band: string;
  params: Record<string, unknown>;
  version: number;
  status: string;
};

type KnowledgeRow = {
  id: string;
  title: string;
  summary: string;
  updated_at: Date;
};

const candidateSchema = z
  .object({
    stem: z.string().min(1).max(20000),
    referenceAnswer: z.string().min(1).max(10000),
    answerType: z.enum(["number", "choice", "worked", "open"]),
    requiresWorking: z.boolean(),
  })
  .strict();

export class QuestionGenerationService {
  constructor(
    private db: Database,
    private jobs: JobQueue,
    private gateway?: ModelGateway,
  ) {}

  async enqueue(
    scope: StudentScope,
    input: QuestionGenerationRequestInput,
  ): Promise<{ runId: string; status: string }> {
    const request = questionGenerationRequestSchema.parse(input);
    const skill = (
      await this.db.pool.query<{ id: string; status: string }>(
        "SELECT id,status FROM skills WHERE id=$1",
        [request.skillId],
      )
    ).rows[0];
    if (!skill || skill.status !== "active")
      throw new AppError("NOT_FOUND", 404, "技能不存在或已停用");

    const dedupeKey = `question_bank.generate:${scope.studentId}:${request.requestKey}`;
    const params = {
      templateCode: request.templateCode,
      templateVersion: request.templateVersion,
      goal: request.goal,
      params: request.params ?? {},
    };
    const evidence = await this.publishedKnowledge(request.skillId);
    if (evidence.length === 0) {
      const run = await this.reserveRun(scope, request.skillId, dedupeKey, {
        requestKey: request.requestKey,
        params,
        status: "failed",
        errorCode: "INSUFFICIENT_EVIDENCE",
        completedAt: true,
      });
      return { runId: run.id, status: "insufficient_evidence" };
    }

    const run = await this.reserveRun(scope, request.skillId, dedupeKey, {
      requestKey: request.requestKey,
      params,
      status: "queued",
    });
    if (run.created)
      await this.jobs.enqueue(this.db.pool, {
        kind: "question_bank.generate",
        dedupeKey,
        payload: { runId: run.id },
      });
    return { runId: run.id, status: this.publicStatus(run.status, run.error_code) };
  }

  async generate(
    runId: string,
    signal?: AbortSignal,
  ): Promise<{ status: string; entryId?: string; reasons?: string[] }> {
    const run = (
      await this.db.pool.query<RunRow>(
        "SELECT * FROM question_generation_runs WHERE id=$1",
        [runId],
      )
    ).rows[0];
    if (!run) throw new Error("GENERATION_RUN_NOT_FOUND");
    if (run.status === "succeeded" || run.status === "failed")
      return { status: run.status };
    await this.db.pool.query(
      "UPDATE question_generation_runs SET status='running' WHERE id=$1 AND status='queued'",
      [runId],
    );

    const skill = (
      await this.db.pool.query<{ id: string; name: string }>(
        "SELECT id,name FROM skills WHERE id=$1",
        [run.skill_id],
      )
    ).rows[0];
    if (!skill) return this.fail(run, "SKILL_NOT_FOUND");

    const evidenceRows = await this.publishedKnowledge(run.skill_id);
    if (evidenceRows.length === 0)
      return this.fail(run, "INSUFFICIENT_EVIDENCE");
    const knowledge: FrozenKnowledge[] = evidenceRows.map((row) => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      updatedAt: row.updated_at.toISOString(),
      contentHash: createHash("sha256")
        .update(`${row.title}\u0000${row.summary}\u0000${row.updated_at.toISOString()}`)
        .digest("hex"),
    }));
    await this.db.pool.query(
      "UPDATE question_generation_runs SET knowledge_evidence=$2 WHERE id=$1",
      [runId, JSON.stringify(knowledge)],
    );

    const templateCode = run.params.templateCode ?? "llm";
    let candidate: z.infer<typeof candidateSchema>;
    let verification: BankVerification;
    let template: TemplateRow | undefined;
    let templateFingerprint: string | undefined;

    if (templateCode === "llm") {
      if (!this.gateway) return this.fail(run, "MODEL_NOT_CONFIGURED");
      try {
        const response = await this.gateway.complete(
          {
            context: {
              systemPrompt:
                '根据已发布知识点生成一道可明确作答的练习。只输出JSON：{stem,referenceAnswer,answerType:"number"|"choice"|"worked"|"open",requiresWorking:boolean}。',
              messages: [
                {
                  role: "user",
                  timestamp: Date.now(),
                  content: JSON.stringify({
                    skill: skill.name,
                    knowledge: knowledge.map((item) => ({
                      title: item.title,
                      summary: item.summary,
                    })),
                  }),
                },
              ],
            },
          },
          signal ?? AbortSignal.timeout(60000),
        );
        candidate = candidateSchema.parse(parseModelJson(response.text));
      } catch {
        return this.fail(run, "MODEL_TIMEOUT");
      }
      verification = await verifyBankCandidate({
        ...candidate,
        knowledge,
        gateway: this.gateway,
        signal,
      });
    } else {
      const found = (
        await this.db.pool.query<TemplateRow>(
          `SELECT id,family,skill_id,difficulty_band,params,version,status
           FROM question_templates
           WHERE family=$1 AND status <> 'rejected'
             AND (skill_id=$2 OR skill_id IS NULL)
           ORDER BY (skill_id=$2) DESC, created_at DESC
           LIMIT 1`,
          [templateCode, run.skill_id],
        )
      ).rows[0];
      if (!found) return this.fail(run, "TEMPLATE_UNKNOWN");
      template = found;
      const params = { ...found.params, ...(run.params.params ?? {}) };
      let solved;
      try {
        solved = instantiateTemplate(templateCode, found.version, params);
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as TemplateValidationError).code)
            : "TEMPLATE_INVALID";
        return this.fail(run, code);
      }
      const approved =
        found.status === "approved" &&
        (!run.params.templateVersion ||
          run.params.templateVersion === found.version);
      candidate = {
        stem: solved.stem,
        referenceAnswer: solved.answer,
        answerType: "number",
        requiresWorking: false,
      };
      templateFingerprint = solved.fingerprint;
      verification = await verifyBankCandidate({
        ...candidate,
        knowledge,
        template: {
          code: templateCode,
          version: found.version,
          params,
          approved,
        },
      });
    }

    if (verification.status === "rejected") {
      await this.db.pool.query(
        `UPDATE question_generation_runs
         SET status='failed',error_code='CANDIDATE_REJECTED',
             params=params||jsonb_build_object('reasons',$2),
             completed_at=now()
         WHERE id=$1`,
        [runId, JSON.stringify(verification.reasons)],
      );
      return { status: "rejected", reasons: verification.reasons };
    }

    const entryId = await this.persist(
      run,
      skill.name,
      candidate,
      verification,
      template,
      templateCode,
      knowledge,
      templateFingerprint,
    );
    await this.db.pool.query(
      "UPDATE question_generation_runs SET status='succeeded',result_entry_id=$2,completed_at=now() WHERE id=$1",
      [runId, entryId],
    );
    return { status: verification.status, entryId };
  }

  private async persist(
    run: RunRow,
    skillName: string,
    candidate: z.infer<typeof candidateSchema>,
    verification: BankVerification,
    template: TemplateRow | undefined,
    templateCode: string,
    knowledge: FrozenKnowledge[],
    templateFingerprint?: string,
  ): Promise<string> {
    const published = verification.status === "verified";
    const fingerprint =
      templateFingerprint ??
      createHash("sha256")
        .update(`${candidate.stem}\u0000${candidate.referenceAnswer}`)
        .digest("hex");
    const ownerId = run.visibility === "owner_only" ? run.student_id : null;
    try {
      return await inTransaction(this.db, async (tx) => {
        const question = (
          await tx.query(
            "INSERT INTO questions(student_id,revision_id,source_type) VALUES($1,NULL,'bank') RETURNING id",
            [ownerId],
          )
        ).rows[0];
        const version = (
          await tx.query(
            `INSERT INTO question_versions(question_id,version_no,stem,reference_answer,knowledge_point,verification)
             VALUES($1,1,$2,$3,$4,$5) RETURNING id`,
            [
              question.id,
              candidate.stem,
              candidate.referenceAnswer,
              skillName,
              published ? "verified" : "pending",
            ],
          )
        ).rows[0];
        await tx.query(
          `INSERT INTO question_references(question_version_id,answer,answer_type,requires_working,verification,evidence)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [
            version.id,
            candidate.referenceAnswer,
            candidate.answerType,
            candidate.requiresWorking,
            published ? "verified" : "pending",
            JSON.stringify({
              checks: verification.checks,
              reasons: verification.reasons,
              template: templateCode,
              knowledgeItemIds: knowledge.map((item) => item.id),
            }),
          ],
        );
        const entry = (
          await tx.query(
            `INSERT INTO question_bank_entries(
               question_version_id,difficulty_band,complexity_band,visibility,owner_id,
               source_type,source_ref,template_family,content_fingerprint,status,
               published_at,created_by)
             VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [
              version.id,
              template?.difficulty_band ?? "easy",
              run.visibility,
              ownerId,
              template ? "template" : "generated",
              template ? `${templateCode}@${template.version}` : null,
              template ? templateCode : null,
              fingerprint,
              published ? "published" : "pending_review",
              published ? new Date() : null,
              run.requested_by,
            ],
          )
        ).rows[0];
        await tx.query(
          "INSERT INTO question_skill_links(entry_id,skill_id,is_primary) VALUES($1,$2,true)",
          [entry.id, run.skill_id],
        );
        return entry.id as string;
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "23505") {
        const existing = (
          await this.db.pool.query(
            `SELECT id FROM question_bank_entries
             WHERE content_fingerprint=$1 AND visibility=$2
               AND owner_id IS NOT DISTINCT FROM $3
             LIMIT 1`,
            [fingerprint, run.visibility, ownerId],
          )
        ).rows[0];
        if (existing) return existing.id as string;
      }
      throw error;
    }
  }

  private async publishedKnowledge(skillId: string) {
    return (
      await this.db.pool.query<KnowledgeRow>(
        `SELECT ki.id,ki.title,ki.summary,ki.updated_at
         FROM skill_content_links scl
         JOIN knowledge_items ki ON ki.id=scl.knowledge_item_id
         WHERE scl.skill_id=$1 AND ki.status='published'
         ORDER BY ki.updated_at DESC, ki.id
         LIMIT 5`,
        [skillId],
      )
    ).rows;
  }

  private async reserveRun(
    scope: StudentScope,
    skillId: string,
    dedupeKey: string,
    input: {
      requestKey: string;
      params: unknown;
      status: "queued" | "failed";
      errorCode?: string;
      completedAt?: boolean;
    },
  ): Promise<{ id: string; status: string; error_code: string | null; created: boolean }> {
    const inserted = await this.db.pool.query<{
      id: string;
      status: string;
      error_code: string | null;
    }>(
      `INSERT INTO question_generation_runs(
         skill_id,status,requested_by,student_id,visibility,request_key,dedupe_key,
         params,error_code,completed_at)
       VALUES($1,$2,$3,$4,'owner_only',$5,$6,$7,$8,$9)
       ON CONFLICT(dedupe_key) DO NOTHING
       RETURNING id,status,error_code`,
      [
        skillId,
        input.status,
        scope.actor.userId,
        scope.studentId,
        input.requestKey,
        dedupeKey,
        JSON.stringify(input.params),
        input.errorCode ?? null,
        input.completedAt ? new Date() : null,
      ],
    );
    if (inserted.rows[0]) return { ...inserted.rows[0], created: true };
    const existing = (
      await this.db.pool.query<{
        id: string;
        status: string;
        error_code: string | null;
      }>(
        "SELECT id,status,error_code FROM question_generation_runs WHERE dedupe_key=$1",
        [dedupeKey],
      )
    ).rows[0]!;
    return { ...existing, created: false };
  }

  private publicStatus(status: string, errorCode: string | null): string {
    if (errorCode === "INSUFFICIENT_EVIDENCE") return "insufficient_evidence";
    if (status === "succeeded") return "succeeded";
    if (status === "failed") return "failed";
    return "queued";
  }

  private async fail(run: RunRow, errorCode: string) {
    await this.db.pool.query(
      "UPDATE question_generation_runs SET status='failed',error_code=$2,completed_at=now() WHERE id=$1",
      [run.id, errorCode],
    );
    return { status: "failed" as const, reasons: [errorCode] };
  }
}
